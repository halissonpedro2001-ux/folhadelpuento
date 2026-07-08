-- Schema D1 — Sistema Folha de Ponto NEW Elevadores
-- Idempotente: pode ser executado novamente sem apagar dados.
-- Compativel com o schema existente do sistema-integrado-new.

-- Tabela de usuarios do sistema de ponto
CREATE TABLE IF NOT EXISTS fp_usuarios (
  id TEXT PRIMARY KEY,
  nome TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,
  cargo TEXT,
  setor TEXT,
  gestor TEXT,
  unidade TEXT DEFAULT 'Manaus/AM',
  jornada_padrao TEXT DEFAULT '08:00 às 17:30',
  carga_diaria REAL DEFAULT 8.5,
  matricula TEXT,
  perfil TEXT NOT NULL DEFAULT 'funcionario',
  situacao TEXT NOT NULL DEFAULT 'ATIVO',
  totp_ativo INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  saldo_anterior REAL DEFAULT 0,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  deletado_em TEXT
);
CREATE INDEX IF NOT EXISTS idx_fp_usuarios_email ON fp_usuarios(email);
CREATE INDEX IF NOT EXISTS idx_fp_usuarios_situacao ON fp_usuarios(situacao);

-- Tabela de sessoes autenticadas
CREATE TABLE IF NOT EXISTS fp_sessoes (
  token TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL,
  email TEXT NOT NULL,
  perfil TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  FOREIGN KEY (usuario_id) REFERENCES fp_usuarios(id)
);
CREATE INDEX IF NOT EXISTS idx_fp_sessoes_usuario ON fp_sessoes(usuario_id);
CREATE INDEX IF NOT EXISTS idx_fp_sessoes_expira ON fp_sessoes(expira_em);

-- Tabela de tentativas de login (rate limiting e auditoria)
CREATE TABLE IF NOT EXISTS fp_login_tentativas (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  ip TEXT,
  sucesso INTEGER NOT NULL DEFAULT 0,
  motivo_falha TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_login_email ON fp_login_tentativas(email, criado_em);

-- Tabela de registros de ponto diario
CREATE TABLE IF NOT EXISTS fp_registros_ponto (
  id TEXT PRIMARY KEY,
  usuario_id TEXT NOT NULL,
  data TEXT NOT NULL,
  entrada TEXT,
  saida_almoco TEXT,
  retorno_almoco TEXT,
  saida TEXT,
  ocorrencia TEXT,
  observacoes TEXT,
  horas_trabalhadas REAL,
  horas_previstas REAL,
  credito_bh REAL DEFAULT 0,
  debito_bh REAL DEFAULT 0,
  saldo_dia REAL DEFAULT 0,
  tipo_dia TEXT,
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL,
  criado_por TEXT,
  FOREIGN KEY (usuario_id) REFERENCES fp_usuarios(id),
  UNIQUE (usuario_id, data)
);
CREATE INDEX IF NOT EXISTS idx_fp_ponto_usuario_data ON fp_registros_ponto(usuario_id, data DESC);
CREATE INDEX IF NOT EXISTS idx_fp_ponto_data ON fp_registros_ponto(data DESC);

-- Tabela de feriados
CREATE TABLE IF NOT EXISTS fp_feriados (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL UNIQUE,
  descricao TEXT NOT NULL,
  tipo TEXT DEFAULT 'Nacional',
  local TEXT DEFAULT 'Brasil',
  observacao TEXT,
  criado_em TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_fp_feriados_data ON fp_feriados(data);

-- Inserir feriados de 2026 (baseados na planilha)
INSERT OR IGNORE INTO fp_feriados (id, data, descricao, tipo, local, criado_em) VALUES
  ('fer-2026-01-01', '2026-01-01', 'Confraternização Universal', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-02-16', '2026-02-16', 'Carnaval', 'Ponto facultativo', 'Brasil', datetime('now')),
  ('fer-2026-02-17', '2026-02-17', 'Carnaval', 'Ponto facultativo', 'Brasil', datetime('now')),
  ('fer-2026-04-03', '2026-04-03', 'Sexta-feira Santa', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-04-21', '2026-04-21', 'Tiradentes', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-05-01', '2026-05-01', 'Dia do Trabalho', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-06-04', '2026-06-04', 'Corpus Christi', 'Ponto facultativo', 'Brasil', datetime('now')),
  ('fer-2026-09-07', '2026-09-07', 'Independência do Brasil', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-10-12', '2026-10-12', 'Nossa Senhora Aparecida', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-11-02', '2026-11-02', 'Finados', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-11-15', '2026-11-15', 'Proclamação da República', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-11-20', '2026-11-20', 'Consciência Negra', 'Nacional', 'Brasil', datetime('now')),
  ('fer-2026-12-25', '2026-12-25', 'Natal', 'Nacional', 'Brasil', datetime('now'));

-- Registro de migracoes
CREATE TABLE IF NOT EXISTS fp_migrations (
  id TEXT PRIMARY KEY,
  descricao TEXT NOT NULL,
  aplicado_em TEXT NOT NULL
);
INSERT OR IGNORE INTO fp_migrations (id, descricao, aplicado_em)
VALUES (
  '2026-07-08-folha-ponto-v1',
  'Schema inicial do sistema de folha de ponto com autenticacao 2FA',
  strftime('%Y-%m-%dT%H:%M:%fZ','now')
);
