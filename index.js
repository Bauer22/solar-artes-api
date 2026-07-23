require('dotenv').config();
const express = require('express');
const mysql   = require('mysql2/promise');
const cors    = require('cors');
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');

const app  = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['*'] }));
app.options('*', cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── BANCO ─────────────────────────────────────────────────────
let pool;
async function getDB() {
  if (!pool) {
    // Railway injeta MYSQL_URL — usar direto é mais simples
    const config = process.env.MYSQL_URL || process.env.DATABASE_URL
      ? {
          uri: process.env.MYSQL_URL || process.env.DATABASE_URL,
          ssl: { rejectUnauthorized: false },
          waitForConnections: true,
          connectionLimit: 10,
        }
      : {
          host:     process.env.MYSQLHOST,
          port:     parseInt(process.env.MYSQLPORT || '3306'),
          user:     process.env.MYSQLUSER,
          password: process.env.MYSQLPASSWORD,
          database: process.env.MYSQLDATABASE,
          ssl:      { rejectUnauthorized: false },
          waitForConnections: true,
          connectionLimit: 10,
          connectTimeout: 30000,
        };
    pool = mysql.createPool(config);
  }
  return pool;
}

const genId = () => 'sa_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
const safeJSON = s => { try { return typeof s==='string'?JSON.parse(s):(s||[]); } catch { return []; } };
const hashSenha = s => crypto.createHash('sha256').update(String(s) + '::solar_artes_salt_2026').digest('hex');
const TOKENS = new Map();

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  const user = token && TOKENS.get(token);
  if (!user) return res.status(401).json({ error: 'nao_autenticado' });
  req.user = user;
  next();
}
function superOnly(req, res, next) {
  if (req.user.role !== 'superadmin') return res.status(403).json({ error: 'apenas_superadmin' });
  next();
}

// ── INIT DB ───────────────────────────────────────────────────
async function initDB() {
  const db = await getDB();
  await db.execute(`CREATE TABLE IF NOT EXISTS produtos (
    id VARCHAR(50) PRIMARY KEY, nome VARCHAR(200) NOT NULL,
    custo DECIMAL(10,2) DEFAULT 0, venda DECIMAL(10,2) DEFAULT 0,
    estoque INT DEFAULT 10, estoque_min INT DEFAULT 3,
    criado DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS clientes (
    id VARCHAR(50) PRIMARY KEY, nome VARCHAR(200) NOT NULL,
    tel VARCHAR(50) DEFAULT '', obs TEXT,
    criado DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS vendas (
    id VARCHAR(50) PRIMARY KEY, data DATE NOT NULL,
    cliente_id VARCHAR(50), itens_json LONGTEXT,
    total DECIMAL(10,2) DEFAULT 0, lucro DECIMAL(10,2) DEFAULT 0,
    pagamento VARCHAR(20) DEFAULT 'dinheiro', vencimento DATE,
    entrada DECIMAL(10,2) DEFAULT 0, pago TINYINT(1) DEFAULT 0,
    obs TEXT, criado DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS agenda (
    id VARCHAR(50) PRIMARY KEY, tipo VARCHAR(30) DEFAULT 'tarefa',
    titulo VARCHAR(300) NOT NULL, descricao TEXT,
    data DATE, hora VARCHAR(10) DEFAULT '09:00',
    venda_id VARCHAR(50), concluida TINYINT(1) DEFAULT 0,
    criado DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const col of ["descricao TEXT", "emoji VARCHAR(10)", "tag VARCHAR(50)", "foto TEXT"]) {
    try { await db.execute('ALTER TABLE produtos ADD COLUMN ' + col); } catch(e) {}
  }
  await db.execute(`CREATE TABLE IF NOT EXISTS config (
    chave VARCHAR(100) PRIMARY KEY, valor TEXT
  )`);
  await db.execute(`CREATE TABLE IF NOT EXISTS usuarios (
    id VARCHAR(50) PRIMARY KEY, nome VARCHAR(200) NOT NULL,
    usuario VARCHAR(100) NOT NULL UNIQUE, senha_hash VARCHAR(100) NOT NULL,
    role VARCHAR(20) DEFAULT 'vendedor', ativo TINYINT(1) DEFAULT 1,
    criado DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  const [urows] = await db.execute('SELECT COUNT(*) as c FROM usuarios');
  if (urows[0].c === 0) {
    await db.execute('INSERT INTO usuarios (id,nome,usuario,senha_hash,role) VALUES (?,?,?,?,?)',
      [genId(),'Super Admin','admin',hashSenha('SolarArtes2026'),'superadmin']);
    console.log('Superadmin criado: admin');
  }
  const [rows] = await db.execute('SELECT COUNT(*) as c FROM produtos');
  if (rows[0].c === 0) {
    const prods = [
      ['Body Aurora 200ml',18.68,45],['Body Moon Mist 200ml',25,65],
      ['Body Fly',25.28,60],['Body Liria',26.56,60],
      ['Body Sky',22.44,65],['Body 002',22.45,65],
    ];
    for (const [nome,custo,venda] of prods) {
      await db.execute('INSERT INTO produtos (id,nome,custo,venda) VALUES (?,?,?,?)',[genId(),nome,custo,venda]);
    }
    console.log('Produtos seed inseridos!');
  }
  console.log('DB pronto!');
}

// ── ROTAS ─────────────────────────────────────────────────────
// Servir o site (index.html no mesmo repositório)
app.get('/', (req, res) => {
  const f = path.join(__dirname, 'index.html');
  if (fs.existsSync(f)) return res.sendFile(f);
  res.json({ status: 'ok', app: 'Solar Artes API' });
});
app.get('/health', (req,res) => res.json({status:'ok'}));

app.get('/api/sync', async (req,res) => {
  try {
    const db = await getDB();
    const [produtos]  = await db.execute('SELECT * FROM produtos ORDER BY nome');
    const [vendas]    = await db.execute('SELECT * FROM vendas ORDER BY criado DESC');
    const [clientes]  = await db.execute('SELECT * FROM clientes ORDER BY nome');
    const [agenda]    = await db.execute('SELECT * FROM agenda ORDER BY data ASC');
    res.json({
      produtos,
      vendas:   vendas.map(v=>({...v,itens:safeJSON(v.itens_json),pago:!!v.pago})),
      clientes,
      agenda:   agenda.map(a=>({...a,concluida:!!a.concluida})),
      ts: Date.now()
    });
  } catch(e) { console.error(e); res.status(500).json({error:e.message}); }
});

// ── AUTENTICAÇÃO ──────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  try {
    const { usuario, senha } = req.body || {};
    if (!usuario || !senha) return res.status(400).json({ error: 'dados_incompletos' });
    const db = await getDB();
    const [rows] = await db.execute('SELECT * FROM usuarios WHERE usuario=? AND ativo=1', [String(usuario).toLowerCase().trim()]);
    if (!rows.length || rows[0].senha_hash !== hashSenha(senha)) {
      return res.status(401).json({ error: 'usuario_ou_senha_invalidos' });
    }
    const token = crypto.randomBytes(24).toString('hex');
    TOKENS.set(token, { id: rows[0].id, usuario: rows[0].usuario, nome: rows[0].nome, role: rows[0].role });
    res.json({ ok: true, token, nome: rows[0].nome, usuario: rows[0].usuario, role: rows[0].role });
  } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/api/me', auth, (req, res) => res.json({ ok: true, ...req.user }));

app.get('/api/usuarios', auth, superOnly, async (req, res) => {
  const [rows] = await (await getDB()).execute('SELECT id,nome,usuario,role,ativo,criado FROM usuarios ORDER BY nome');
  res.json(rows.map(u => ({ ...u, ativo: !!u.ativo })));
});

app.post('/api/usuarios', auth, superOnly, async (req, res) => {
  try {
    const d = req.body || {};
    if (!d.nome || !d.usuario || !d.senha) return res.status(400).json({ error: 'dados_incompletos' });
    const db = await getDB();
    const id = genId();
    await db.execute(
      'INSERT INTO usuarios (id,nome,usuario,senha_hash,role) VALUES (?,?,?,?,?)',
      [id, d.nome, String(d.usuario).toLowerCase().trim(), hashSenha(d.senha), d.role === 'superadmin' ? 'superadmin' : 'vendedor']
    );
    res.json({ ok: true, id });
  } catch (e) {
    if (String(e.message).includes('Duplicate')) return res.status(409).json({ error: 'usuario_ja_existe' });
    res.status(500).json({ error: e.message });
  }
});

app.put('/api/usuarios/:id/senha', auth, async (req, res) => {
  try {
    const { senha } = req.body || {};
    if (!senha) return res.status(400).json({ error: 'senha_obrigatoria' });
    if (req.user.role !== 'superadmin' && req.user.id !== req.params.id) {
      return res.status(403).json({ error: 'sem_permissao' });
    }
    await (await getDB()).execute('UPDATE usuarios SET senha_hash=? WHERE id=?', [hashSenha(senha), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/usuarios/:id', auth, superOnly, async (req, res) => {
  if (req.user.id === req.params.id) return res.status(400).json({ error: 'nao_pode_excluir_a_si_mesmo' });
  await (await getDB()).execute('UPDATE usuarios SET ativo=0 WHERE id=?', [req.params.id]);
  res.json({ ok: true });
});

// Produtos
app.post('/api/produtos', async (req,res) => {
  try {
    const d=req.body, id=d.id||genId();
    await (await getDB()).execute(
      'INSERT INTO produtos (id,nome,custo,venda,estoque,estoque_min,descricao,emoji,tag,foto) VALUES (?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE nome=?,custo=?,venda=?,estoque=?,estoque_min=?,descricao=?,emoji=?,tag=?,foto=?',
      [id,d.nome,d.custo||0,d.venda||0,d.estoque??10,d.estoqueMin||3,d.descricao||'',d.emoji||'🌿',d.tag||null,d.foto||null,
       d.nome,d.custo||0,d.venda||0,d.estoque??10,d.estoqueMin||3,d.descricao||'',d.emoji||'🌿',d.tag||null,d.foto||null]
    );
    res.json({ok:true,id});
  } catch(e){res.status(500).json({error:e.message});}
});

// Config do site (público lê, admin edita)
app.get('/api/config', async (req,res) => {
  try {
    const [rows] = await (await getDB()).execute('SELECT * FROM config');
    const o = {}; rows.forEach(r => o[r.chave] = r.valor);
    res.json(o);
  } catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/config', auth, async (req,res) => {
  try {
    const db = await getDB();
    for (const [k,v] of Object.entries(req.body||{})) {
      await db.execute('INSERT INTO config (chave,valor) VALUES (?,?) ON DUPLICATE KEY UPDATE valor=?',[k,String(v),String(v)]);
    }
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/produtos/:id', async (req,res) => {
  await (await getDB()).execute('DELETE FROM produtos WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// Clientes
app.post('/api/clientes', async (req,res) => {
  try {
    const d=req.body, id=d.id||genId();
    await (await getDB()).execute(
      'INSERT INTO clientes (id,nome,tel,obs) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE nome=?,tel=?,obs=?',
      [id,d.nome,d.tel||'',d.obs||'',d.nome,d.tel||'',d.obs||'']
    );
    res.json({ok:true,id});
  } catch(e){res.status(500).json({error:e.message});}
});
app.delete('/api/clientes/:id', async (req,res) => {
  await (await getDB()).execute('DELETE FROM clientes WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// Vendas
app.post('/api/vendas', async (req,res) => {
  try {
    const d=req.body, db=await getDB(), id=d.id||genId();
    await db.execute(
      'INSERT INTO vendas (id,data,cliente_id,itens_json,total,lucro,pagamento,vencimento,entrada,pago,obs) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      [id,d.data,d.clienteId||null,JSON.stringify(d.itens||[]),d.total||0,d.lucro||0,d.pagamento||'dinheiro',d.vencimento||null,d.entrada||0,d.pago?1:0,d.obs||'']
    );
    for (const it of (d.itens||[])) {
      await db.execute('UPDATE produtos SET estoque=GREATEST(0,estoque-?) WHERE id=?',[it.qtd,it.prodId]);
    }
    if (d.pagamento==='prazo'&&d.agendaItem) {
      const ai=d.agendaItem, aid=ai.id||genId();
      await db.execute(
        'INSERT INTO agenda (id,tipo,titulo,descricao,data,hora,venda_id,concluida) VALUES (?,?,?,?,?,?,?,0)',
        [aid,ai.tipo||'prazo',ai.titulo,ai.descricao||'',ai.data,ai.hora||'09:00',id]
      );
    }
    res.json({ok:true,id});
  } catch(e){console.error(e);res.status(500).json({error:e.message});}
});
app.put('/api/vendas/:id', async (req,res) => {
  const db=await getDB();
  await db.execute('UPDATE vendas SET pago=? WHERE id=?',[req.body.pago?1:0,req.params.id]);
  if (req.body.pago) await db.execute('UPDATE agenda SET concluida=1 WHERE venda_id=?',[req.params.id]);
  res.json({ok:true});
});
app.delete('/api/vendas/:id', async (req,res) => {
  const db=await getDB();
  await db.execute('DELETE FROM vendas WHERE id=?',[req.params.id]);
  await db.execute('DELETE FROM agenda WHERE venda_id=?',[req.params.id]);
  res.json({ok:true});
});

// Agenda
app.post('/api/agenda', async (req,res) => {
  try {
    const d=req.body, id=d.id||genId();
    await (await getDB()).execute(
      'INSERT INTO agenda (id,tipo,titulo,descricao,data,hora,venda_id,concluida) VALUES (?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE concluida=?',
      [id,d.tipo||'tarefa',d.titulo,d.descricao||'',d.data,d.hora||'09:00',d.vendaId||null,d.concluida?1:0,d.concluida?1:0]
    );
    res.json({ok:true,id});
  } catch(e){res.status(500).json({error:e.message});}
});
app.put('/api/agenda/:id', async (req,res) => {
  await (await getDB()).execute('UPDATE agenda SET concluida=? WHERE id=?',[req.body.concluida?1:0,req.params.id]);
  res.json({ok:true});
});
app.delete('/api/agenda/:id', async (req,res) => {
  await (await getDB()).execute('DELETE FROM agenda WHERE id=?',[req.params.id]);
  res.json({ok:true});
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Solar Artes API rodando na porta ${PORT}`);
  try { await initDB(); }
  catch(e) { console.error('Erro init DB:', e.message); }
});
