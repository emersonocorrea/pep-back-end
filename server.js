const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const { ThermalPrinter, PrinterTypes, CharacterSet } = require('node-thermal-printer');
const app = express();
const port = 5000;

app.use(cors());
app.use(express.json());

// Conectar ao banco SQLite
const db = new sqlite3.Database('./senhas.db', (err) => {
  if (err) console.error('Erro ao conectar ao SQLite:', err);
  else console.log('Conectado ao SQLite.');
});

// Tabelas (sem alterações)
db.run(`
  CREATE TABLE IF NOT EXISTS Senhas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    senha TEXT NOT NULL,
    data_hora TEXT NOT NULL,
    status TEXT DEFAULT 'pendente'
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS Pacientes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    senha_id INTEGER,
    nome TEXT NOT NULL,
    cpf TEXT NOT NULL,
    data_nascimento TEXT,
    telefone TEXT,
    FOREIGN KEY (senha_id) REFERENCES Senhas(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS Triagem (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    senha_id INTEGER,
    pressao TEXT,
    pulso INTEGER,
    temperatura REAL,
    saturacao INTEGER,
    sintomas TEXT,
    risco TEXT NOT NULL,
    data_hora TEXT NOT NULL,
    FOREIGN KEY (senha_id) REFERENCES Senhas(id)
  )
`);

db.run(`
  CREATE TABLE IF NOT EXISTS Atendimentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    senha_id INTEGER,
    anamnese TEXT,
    exame_fisico TEXT,
    diagnostico TEXT,
    prescricao TEXT,
    evolucao TEXT,
    data_hora TEXT NOT NULL,
    FOREIGN KEY (senha_id) REFERENCES Senhas(id)
  )
`);

// Impressoras (sem alterações)
const senhaPrinter = new ThermalPrinter({
  type: PrinterTypes.EPSON,
  interface: 'usb://0x0416/0x5011', // Substitua pelos IDs reais da AP-805
  characterSet: CharacterSet.PC850_MULTILINGUAL,
  removeSpecialCharacters: false,
  lineCharacter: '-',
});

const etiquetaPrinter = new ThermalPrinter({
  type: PrinterTypes.EPSON,
  interface: 'usb://0x04b8/0x0e15', // Substitua pelos IDs reais da GK420t
  characterSet: CharacterSet.PC850_MULTILINGUAL,
  removeSpecialCharacters: false,
  lineCharacter: '-',
});

senhaPrinter.isPrinterConnected()
  .then((connected) => console.log('Impressora de senhas (Brazil PC AP-805) conectada:', connected))
  .catch((err) => console.error('Erro ao conectar impressora de senhas (AP-805):', err));

etiquetaPrinter.isPrinterConnected()
  .then((connected) => console.log('Impressora de etiquetas (Zebra GK420t) conectada:', connected))
  .catch((err) => console.error('Erro ao conectar impressora de etiquetas (GK420t):', err));

// Funções de impressão (sem alterações)
const imprimirSenha = async (senha, dataHora) => {
  try {
    console.log('Tentando imprimir senha com AP-805:', senha);
    senhaPrinter.alignCenter();
    senhaPrinter.println('SENHA DE ATENDIMENTO');
    senhaPrinter.println(`Senha: ${senha}`);
    senhaPrinter.println(`Data: ${new Date(dataHora).toLocaleString()}`);
    senhaPrinter.println('Aguarde sua vez!');
    senhaPrinter.drawLine();
    senhaPrinter.cut();
    await senhaPrinter.execute();
    console.log(`Senha ${senha} impressa com sucesso na AP-805.`);
    return true;
  } catch (error) {
    console.error('Erro ao imprimir senha na AP-805:', error);
    throw error;
  }
};

const imprimirEtiqueta = async (nome, cpf, senha) => {
  try {
    console.log('Tentando imprimir etiqueta com Zebra GK420t para:', nome);
    etiquetaPrinter.alignLeft();
    etiquetaPrinter.println(`Nome: ${nome}`);
    etiquetaPrinter.println(`CPF: ${cpf}`);
    etiquetaPrinter.println(`Senha: ${senha}`);
    etiquetaPrinter.drawLine();
    etiquetaPrinter.cut();
    await etiquetaPrinter.execute();
    console.log(`Etiqueta para ${nome} impressa com sucesso na GK420t.`);
    return true;
  } catch (error) {
    console.error('Erro ao imprimir etiqueta na GK420t:', error);
    throw error;
  }
};

// Contar senhas do dia
const getSenhasDoDia = () => {
  return new Promise((resolve, reject) => {
    const hoje = new Date().toISOString().split('T')[0];
    db.get(`SELECT COUNT(*) as total FROM Senhas WHERE data_hora LIKE ?`, [`${hoje}%`], (err, row) => {
      if (err) reject(err);
      else resolve(row.total);
    });
  });
};

// Rota para gerar senha
app.get('/api/gerar-senha', async (req, res) => {
  console.log('Requisição recebida em /api/gerar-senha');
  try {
    const totalHoje = await getSenhasDoDia();
    const novoNumero = totalHoje + 1;
    const senha = `G${String(novoNumero).padStart(3, '0')}`;
    const dataHora = new Date().toISOString();

    db.run('INSERT INTO Senhas (senha, data_hora) VALUES (?, ?)', [senha, dataHora], async (err) => {
      if (err) return res.status(500).json({ error: 'Erro ao salvar senha' });
      let printed = false;
      try {
        await imprimirSenha(senha, dataHora);
        printed = true;
      } catch (printError) {
        console.error('Impressão falhou na AP-805:', printError);
      }
      res.json({
        senha,
        dataHora,
        totalHoje: novoNumero,
        printed,
        warning: printed ? null : 'Impressão falhou na AP-805, mas senha foi gerada'
      });
    });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao gerar senha', details: error.message });
  }
});

// Rota para cadastrar paciente
app.post('/api/cadastrar-paciente', async (req, res) => {
  const { senha, nome, cpf, dataNascimento, telefone } = req.body;
  if (!senha || !nome || !cpf) {
    return res.status(400).json({ error: 'Senha, nome e CPF são obrigatórios' });
  }

  db.get('SELECT id, status FROM Senhas WHERE senha = ?', [senha], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || row.status !== 'pendente') {
      return res.status(400).json({ error: 'Senha inválida ou já cadastrada' });
    }

    const senhaId = row.id;

    db.run(
      'INSERT INTO Pacientes (senha_id, nome, cpf, data_nascimento, telefone) VALUES (?, ?, ?, ?, ?)',
      [senhaId, nome, cpf, dataNascimento, telefone],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE Senhas SET status = ? WHERE id = ?', ['cadastrado', senhaId], async (err) => {
          if (err) return res.status(500).json({ error: err.message });
          let printed = false;
          try {
            await imprimirEtiqueta(nome, cpf, senha);
            printed = true;
          } catch (printError) {
            console.error('Impressão falhou na GK420t:', printError);
          }
          res.json({
            message: printed ? 'Paciente cadastrado e etiqueta impressa' : 'Paciente cadastrado, mas impressão falhou',
            senha,
            nome,
            cpf,
            printed,
          });
        });
      }
    );
  });
});

// Rota para classificar risco
app.post('/api/classificar-risco', async (req, res) => {
  const { senha, pressao, pulso, temperatura, saturacao, sintomas, risco } = req.body;
  if (!senha || !risco) {
    return res.status(400).json({ error: 'Senha e nível de risco são obrigatórios' });
  }

  db.get('SELECT id, status FROM Senhas WHERE senha = ?', [senha], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || row.status !== 'cadastrado') {
      return res.status(400).json({ error: 'Senha inválida ou não cadastrada' });
    }

    const senhaId = row.id;
    const dataHora = new Date().toISOString();

    db.run(
      'INSERT INTO Triagem (senha_id, pressao, pulso, temperatura, saturacao, sintomas, risco, data_hora) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [senhaId, pressao, pulso, temperatura, saturacao, sintomas, risco, dataHora],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE Senhas SET status = ? WHERE id = ?', ['classificado', senhaId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            message: 'Paciente classificado com sucesso',
            senha,
            risco,
          });
        });
      }
    );
  });
});

// Rota para buscar dados do paciente
app.get('/api/paciente/:senha', (req, res) => {
  const { senha } = req.params;
  db.get(
    `SELECT s.senha, s.status, p.nome, p.cpf, p.data_nascimento, p.telefone,
            t.pressao, t.pulso, t.temperatura, t.saturacao, t.sintomas, t.risco
     FROM Senhas s
     LEFT JOIN Pacientes p ON s.id = p.senha_id
     LEFT JOIN Triagem t ON s.id = t.senha_id
     WHERE s.senha = ?`,
    [senha],
    (err, row) => {
      if (err) return res.status(500).json({ error: err.message });
      if (!row) return res.status(404).json({ error: 'Senha não encontrada' });
      res.json(row);
    }
  );
});

// Rota para registrar atendimento
app.post('/api/atendimento', async (req, res) => {
  const { senha, anamnese, exame_fisico, diagnostico, prescricao, evolucao } = req.body;
  if (!senha) {
    return res.status(400).json({ error: 'Senha é obrigatória' });
  }

  db.get('SELECT id, status FROM Senhas WHERE senha = ?', [senha], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || row.status !== 'classificado') {
      return res.status(400).json({ error: 'Senha inválida ou não classificada' });
    }

    const senhaId = row.id;
    const dataHora = new Date().toISOString();

    db.run(
      'INSERT INTO Atendimentos (senha_id, anamnese, exame_fisico, diagnostico, prescricao, evolucao, data_hora) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [senhaId, anamnese, exame_fisico, diagnostico, prescricao, evolucao, dataHora],
      async (err) => {
        if (err) return res.status(500).json({ error: err.message });
        db.run('UPDATE Senhas SET status = ? WHERE id = ?', ['atendido', senhaId], (err) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json({
            message: 'Atendimento registrado com sucesso',
            senha,
          });
        });
      }
    );
  });
});



// ... (código anterior mantido até a penúltima rota)

// Rota atualizada para listar todos os pacientes com filtros por status e nome
app.get('/api/pacientes', (req, res) => {
  const { status, nome } = req.query; // Pegar status e nome da query string
  let query = `
    SELECT s.senha, s.status, s.data_hora as data_registro,
           p.nome, p.cpf, p.data_nascimento, p.telefone,
           t.risco, t.data_hora as data_triagem,
           a.diagnostico, a.data_hora as data_atendimento
    FROM Senhas s
    LEFT JOIN Pacientes p ON s.id = p.senha_id
    LEFT JOIN Triagem t ON s.id = t.senha_id
    LEFT JOIN Atendimentos a ON s.id = a.senha_id
    WHERE 1=1
  `;
  const params = [];

  if (status) {
    query += ` AND s.status = ?`;
    params.push(status);
  }

  if (nome) {
    query += ` AND p.nome LIKE ?`;
    params.push(`%${nome}%`);
  }

  query += ` ORDER BY s.data_hora DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// ... (app.listen mantido)

app.listen(port, () => {
  console.log(`Backend rodando em http://localhost:${port}`);
});