/**
 * functions/api/ponto.js
 * Backend principal do Sistema de Folha de Ponto — NEW Elevadores
 * Cloudflare Pages Functions (ES Module)
 *
 * Endpoints:
 *   POST /api/ponto  { action, ...params }
 *
 * Actions públicas (sem sessão):
 *   login            — autenticar com email + senha
 *   verificar2fa     — validar código TOTP
 *   logout           — encerrar sessão
 *
 * Actions autenticadas (requerem sessão):
 *   configurar2fa    — gerar QR code para configurar TOTP
 *   ativar2fa        — confirmar e ativar TOTP
 *   getMeuPerfil     — dados do usuário logado
 *   getDashboard     — resumo do mês atual
 *   listarPonto      — registros de ponto do mês
 *   salvarPonto      — criar/atualizar registro de ponto
 *   listarFeriados   — feriados cadastrados
 *
 * Actions admin:
 *   listarFuncionarios  — todos os funcionários
 *   salvarFuncionario   — criar/editar funcionário
 *   inativarFuncionario — inativar funcionário
 *   listarTodosPontos   — pontos de todos os funcionários
 *   resetarSenha        — redefinir senha de funcionário
 */

// ─── Constantes ────────────────────────────────────────────────────────────────
const SESSION_TTL_HOURS = 8;
const MAX_LOGIN_ATTEMPTS = 5;
const LOGIN_WINDOW_MINUTES = 15;
const TOTP_DIGITS = 6;
const TOTP_PERIOD = 30;
const TOTP_WINDOW = 1; // aceitar 1 período antes/depois

const OCORRENCIAS = [
  'Trabalhado', 'Folga', 'Atestado', 'Férias',
  'Compensação', 'Falta', 'Banco de Horas', 'Meio período', 'Outro'
];

const OCORRENCIAS_SEM_CARGA = new Set(['Folga', 'Atestado', 'Férias', 'Compensação']);

// ─── Entry point ───────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;

  // CORS preflight
  if (request.method === 'OPTIONS') {
    return corsResponse();
  }

  if (request.method !== 'POST') {
    return jsonError('Método não permitido.', 405);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonError('Corpo da requisição inválido.', 400);
  }

  const action = String(body.action || '').trim();
  if (!action) return jsonError('Ação não informada.', 400);

  const db = env.DB;
  if (!db) return jsonError('Banco de dados não configurado.', 500);

  try {
    // Ações públicas
    if (action === 'login') return await handleLogin(db, body, request);
    if (action === 'verificar2fa') return await handleVerificar2fa(db, body, request);
    if (action === 'logout') return await handleLogout(db, body);
    if (action === 'setupAdmin') return await handleSetupAdmin(db, body, env);

    // Ações autenticadas
    const sessao = await validarSessao(db, body.token);
    if (!sessao) return jsonError('Sessão inválida ou expirada. Faça login novamente.', 401);

    if (action === 'configurar2fa') return await handleConfigurar2fa(db, sessao);
    if (action === 'ativar2fa') return await handleAtivar2fa(db, sessao, body);
    if (action === 'alterarMinhaSenha') return await handleAlterarMinhaSenha(db, sessao, body);
    if (action === 'getMeuPerfil') return await handleGetMeuPerfil(db, sessao);
    if (action === 'getDashboard') return await handleGetDashboard(db, sessao, body);
    if (action === 'listarPonto') return await handleListarPonto(db, sessao, body);
    if (action === 'salvarPonto') return await handleSalvarPonto(db, sessao, body);
    if (action === 'listarFeriados') return await handleListarFeriados(db);

    // Ações admin
    assertAdmin(sessao);
    if (action === 'listarFuncionarios') return await handleListarFuncionarios(db);
    if (action === 'salvarFuncionario') return await handleSalvarFuncionario(db, sessao, body);
    if (action === 'inativarFuncionario') return await handleInativarFuncionario(db, sessao, body);
    if (action === 'listarTodosPontos') return await handleListarTodosPontos(db, body);
    if (action === 'resetarSenha') return await handleResetarSenha(db, sessao, body);

    return jsonError('Ação não encontrada.', 404);
  } catch (err) {
    const status = Number(err.status || 500);
    const msg = status >= 500 ? 'Erro interno no servidor.' : err.message;
    if (status >= 500) console.error('ponto_error', err.message, err.stack);
    return jsonError(msg, status);
  }
}

// ─── Auth: Login ───────────────────────────────────────────────────────────────
async function handleLogin(db, body, request) {
  const email = normalizeEmail(body.email);
  const senha = String(body.senha || '');

  if (!email || !senha) throw httpError(400, 'Email e senha são obrigatórios.');

  const ip = request.headers.get('CF-Connecting-IP') || '';

  // Verificar rate limit
  const tentativas = await contarTentativasRecentes(db, email, ip);
  if (tentativas >= MAX_LOGIN_ATTEMPTS) {
    await registrarTentativa(db, email, ip, false, 'rate_limit');
    throw httpError(429, `Muitas tentativas de login. Aguarde ${LOGIN_WINDOW_MINUTES} minutos.`);
  }

  const usuario = await buscarUsuarioPorEmail(db, email);
  if (!usuario || usuario.situacao !== 'ATIVO') {
    await registrarTentativa(db, email, ip, false, 'usuario_nao_encontrado');
    throw httpError(401, 'Email ou senha incorretos.');
  }

  const senhaOk = await verificarSenha(senha, usuario.senha_hash);
  if (!senhaOk) {
    await registrarTentativa(db, email, ip, false, 'senha_incorreta');
    throw httpError(401, 'Email ou senha incorretos.');
  }

  await registrarTentativa(db, email, ip, true, null);

  // Se 2FA ativo, criar sessão temporária aguardando 2FA
  if (usuario.totp_ativo) {
    const tokenTemp = await gerarToken();
    const expira = new Date(Date.now() + 5 * 60 * 1000).toISOString(); // 5 min
    await db.prepare(
      'INSERT INTO fp_sessoes (token, usuario_id, email, perfil, criado_em, expira_em, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(tokenTemp, usuario.id, usuario.email, 'pendente_2fa', nowIso(), expira, ip).run();

    return json({ sucesso: true, requer2fa: true, tokenTemp, nome: usuario.nome });
  }

  // Sem 2FA: criar sessão completa
  const token = await criarSessao(db, usuario, ip);
  return json({
    sucesso: true,
    requer2fa: false,
    token,
    perfil: usuario.perfil,
    nome: usuario.nome,
    totp_ativo: false
  });
}

// ─── Auth: Verificar 2FA ───────────────────────────────────────────────────────
async function handleVerificar2fa(db, body, request) {
  const tokenTemp = String(body.tokenTemp || '');
  const codigo = String(body.codigo || '').replace(/\s/g, '');

  if (!tokenTemp || !codigo) throw httpError(400, 'Token temporário e código são obrigatórios.');

  const sessaoTemp = await db.prepare(
    "SELECT * FROM fp_sessoes WHERE token = ? AND perfil = 'pendente_2fa'"
  ).bind(tokenTemp).first();

  if (!sessaoTemp) throw httpError(401, 'Sessão temporária inválida.');
  if (new Date(sessaoTemp.expira_em) < new Date()) {
    await db.prepare('DELETE FROM fp_sessoes WHERE token = ?').bind(tokenTemp).run();
    throw httpError(401, 'Código expirado. Faça login novamente.');
  }

  const usuario = await buscarUsuarioPorId(db, sessaoTemp.usuario_id);
  if (!usuario || !usuario.totp_secret) throw httpError(401, 'Configuração 2FA inválida.');

  const codigoValido = verificarTOTP(usuario.totp_secret, codigo);
  if (!codigoValido) throw httpError(401, 'Código inválido. Verifique o aplicativo autenticador.');

  // Remover sessão temporária e criar sessão completa
  await db.prepare('DELETE FROM fp_sessoes WHERE token = ?').bind(tokenTemp).run();
  const ip = request.headers.get('CF-Connecting-IP') || '';
  const token = await criarSessao(db, usuario, ip);

  return json({
    sucesso: true,
    token,
    perfil: usuario.perfil,
    nome: usuario.nome
  });
}

// ─── Auth: Logout ──────────────────────────────────────────────────────────────
async function handleLogout(db, body) {
  const token = String(body.token || '');
  if (token) {
    await db.prepare('DELETE FROM fp_sessoes WHERE token = ?').bind(token).run();
  }
  return json({ sucesso: true });
}

// ─── 2FA: Configurar ──────────────────────────────────────────────────────────
async function handleConfigurar2fa(db, sessao) {
  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');

  // Gerar novo segredo TOTP
  const secret = gerarTOTPSecret();
  const label = encodeURIComponent(`NEW Elevadores:${usuario.email}`);
  const issuer = encodeURIComponent('NEW Elevadores');
  const otpauth = `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&digits=6&period=30`;

  // Salvar segredo temporariamente (ainda não ativado)
  await db.prepare(
    'UPDATE fp_usuarios SET totp_secret = ?, atualizado_em = ? WHERE id = ?'
  ).bind(secret, nowIso(), usuario.id).run();

  return json({ sucesso: true, secret, otpauth });
}

// ─── 2FA: Ativar ──────────────────────────────────────────────────────────────
async function handleAtivar2fa(db, sessao, body) {
  const codigo = String(body.codigo || '').replace(/\s/g, '');
  if (!codigo) throw httpError(400, 'Código é obrigatório.');

  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario || !usuario.totp_secret) throw httpError(400, 'Configure o 2FA primeiro.');

  const valido = verificarTOTP(usuario.totp_secret, codigo);
  if (!valido) throw httpError(400, 'Código inválido. Verifique o aplicativo autenticador.');

  await db.prepare(
    'UPDATE fp_usuarios SET totp_ativo = 1, atualizado_em = ? WHERE id = ?'
  ).bind(nowIso(), usuario.id).run();

  return json({ sucesso: true, mensagem: 'Verificação em duas etapas ativada com sucesso.' });
}

// ─── Perfil ────────────────────────────────────────────────────────────────────
async function handleGetMeuPerfil(db, sessao) {
  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');
  return json({ sucesso: true, usuario: sanitizarUsuario(usuario) });
}

// ─── Dashboard ─────────────────────────────────────────────────────────────────
async function handleGetDashboard(db, sessao, body) {
  const mesAno = String(body.mesAno || mesAnoAtual());
  const [ano, mes] = mesAno.split('-').map(Number);

  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');

  const feriados = await listarFeriadosDoMes(db, ano, mes);
  const registros = await listarRegistrosMes(db, sessao.usuario_id, ano, mes);

  const resumo = calcularResumoMes(registros, feriados, usuario, ano, mes);

  return json({ sucesso: true, resumo, usuario: sanitizarUsuario(usuario) });
}

// ─── Listar Ponto ─────────────────────────────────────────────────────────────
async function handleListarPonto(db, sessao, body) {
  const mesAno = String(body.mesAno || mesAnoAtual());
  const [ano, mes] = mesAno.split('-').map(Number);

  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');

  const feriados = await listarFeriadosDoMes(db, ano, mes);
  const registros = await listarRegistrosMes(db, sessao.usuario_id, ano, mes);

  // Montar grade completa do mês
  const grade = montarGradeMes(registros, feriados, usuario, ano, mes);

  return json({ sucesso: true, grade, mesAno, feriados });
}

// ─── Salvar Ponto ─────────────────────────────────────────────────────────────
async function handleSalvarPonto(db, sessao, body) {
  const data = String(body.data || '');
  if (!data || !/^\d{4}-\d{2}-\d{2}$/.test(data)) throw httpError(400, 'Data inválida.');

  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');

  const entrada = sanitizarHora(body.entrada);
  const saidaAlmoco = sanitizarHora(body.saida_almoco);
  const retornoAlmoco = sanitizarHora(body.retorno_almoco);
  const saida = sanitizarHora(body.saida);
  const ocorrencia = OCORRENCIAS.includes(body.ocorrencia) ? body.ocorrencia : null;
  const observacoes = String(body.observacoes || '').slice(0, 500);

  // Calcular horas
  const [ano, mes, dia] = data.split('-').map(Number);
  const feriados = await listarFeriadosDoMes(db, ano, mes);
  const tipoDia = classificarDia(new Date(ano, mes - 1, dia), feriados);

  let horasTrabalhadas = null;
  if (entrada && saida) {
    const intervalo = calcularIntervalo(saidaAlmoco, retornoAlmoco);
    horasTrabalhadas = calcularHorasTrabalhadas(entrada, saida, intervalo);
  }

  let horasPrevistas = 0;
  if (tipoDia === 'Dia útil') {
    if (!ocorrencia || !OCORRENCIAS_SEM_CARGA.has(ocorrencia)) {
      horasPrevistas = usuario.carga_diaria || 8.5;
    }
  }

  const credito = (horasTrabalhadas != null && horasTrabalhadas > horasPrevistas && horasPrevistas > 0)
    ? horasTrabalhadas - horasPrevistas : 0;
  const debito = (horasTrabalhadas != null && horasTrabalhadas < horasPrevistas && horasPrevistas > 0 && (entrada || ocorrencia))
    ? horasPrevistas - horasTrabalhadas : 0;
  const saldoDia = credito - debito;

  const id = `ponto-${sessao.usuario_id}-${data}`;
  const agora = nowIso();

  await db.prepare(`
    INSERT INTO fp_registros_ponto
      (id, usuario_id, data, entrada, saida_almoco, retorno_almoco, saida,
       ocorrencia, observacoes, horas_trabalhadas, horas_previstas,
       credito_bh, debito_bh, saldo_dia, tipo_dia, criado_em, atualizado_em, criado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(usuario_id, data) DO UPDATE SET
      entrada = excluded.entrada,
      saida_almoco = excluded.saida_almoco,
      retorno_almoco = excluded.retorno_almoco,
      saida = excluded.saida,
      ocorrencia = excluded.ocorrencia,
      observacoes = excluded.observacoes,
      horas_trabalhadas = excluded.horas_trabalhadas,
      horas_previstas = excluded.horas_previstas,
      credito_bh = excluded.credito_bh,
      debito_bh = excluded.debito_bh,
      saldo_dia = excluded.saldo_dia,
      tipo_dia = excluded.tipo_dia,
      atualizado_em = excluded.atualizado_em
  `).bind(
    id, sessao.usuario_id, data,
    entrada, saidaAlmoco, retornoAlmoco, saida,
    ocorrencia, observacoes,
    horasTrabalhadas, horasPrevistas,
    credito, debito, saldoDia, tipoDia,
    agora, agora, sessao.email
  ).run();

  return json({ sucesso: true, id, data, saldoDia, horasTrabalhadas, horasPrevistas });
}

// ─── Listar Feriados ──────────────────────────────────────────────────────────
async function handleListarFeriados(db) {
  const rows = await db.prepare(
    'SELECT data, descricao, tipo, local FROM fp_feriados ORDER BY data'
  ).all();
  return json({ sucesso: true, feriados: rows.results || [] });
}

// ─── Admin: Listar Funcionários ───────────────────────────────────────────────
async function handleListarFuncionarios(db) {
  const rows = await db.prepare(
    `SELECT id, nome, email, cargo, setor, gestor, unidade, matricula, perfil, situacao,
     totp_ativo, carga_diaria, jornada_padrao, saldo_anterior, criado_em
     FROM fp_usuarios WHERE deletado_em IS NULL ORDER BY nome`
  ).all();
  return json({ sucesso: true, funcionarios: rows.results || [] });
}

// ─── Admin: Salvar Funcionário ────────────────────────────────────────────────
async function handleSalvarFuncionario(db, sessao, body) {
  const id = String(body.id || '').trim() || gerarId();
  const nome = String(body.nome || '').trim().slice(0, 120);
  const email = normalizeEmail(body.email);
  const cargo = String(body.cargo || '').trim().slice(0, 80);
  const setor = String(body.setor || '').trim().slice(0, 80);
  const gestor = String(body.gestor || '').trim().slice(0, 120);
  const unidade = String(body.unidade || 'Manaus/AM').trim().slice(0, 80);
  const matricula = String(body.matricula || '').trim().slice(0, 40);
  const perfil = ['admin', 'funcionario'].includes(body.perfil) ? body.perfil : 'funcionario';
  const situacao = ['ATIVO', 'INATIVO', 'AFASTADO', 'FERIAS'].includes(body.situacao) ? body.situacao : 'ATIVO';
  const cargaDiaria = Number(body.carga_diaria) || 8.5;
  const jornadaPadrao = String(body.jornada_padrao || '08:00 às 17:30').slice(0, 40);
  const saldoAnterior = Number(body.saldo_anterior) || 0;

  if (!nome || !email) throw httpError(400, 'Nome e email são obrigatórios.');

  const agora = nowIso();
  const isNovo = !body.id;

  if (isNovo) {
    // Verificar email duplicado
    const existe = await buscarUsuarioPorEmail(db, email);
    if (existe) throw httpError(409, 'Este email já está cadastrado.');

    const senhaTemp = body.senha || gerarSenhaTemp();
    const senhaHash = await hashSenha(senhaTemp);

    await db.prepare(`
      INSERT INTO fp_usuarios
        (id, nome, email, senha_hash, cargo, setor, gestor, unidade, matricula,
         perfil, situacao, carga_diaria, jornada_padrao, saldo_anterior,
         totp_ativo, criado_em, atualizado_em)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).bind(
      id, nome, email, senhaHash, cargo, setor, gestor, unidade, matricula,
      perfil, situacao, cargaDiaria, jornadaPadrao, saldoAnterior,
      agora, agora
    ).run();

    return json({ sucesso: true, id, senhaTemp, mensagem: 'Funcionário criado. Compartilhe a senha temporária.' });
  } else {
    await db.prepare(`
      UPDATE fp_usuarios SET
        nome = ?, cargo = ?, setor = ?, gestor = ?, unidade = ?, matricula = ?,
        perfil = ?, situacao = ?, carga_diaria = ?, jornada_padrao = ?,
        saldo_anterior = ?, atualizado_em = ?
      WHERE id = ?
    `).bind(
      nome, cargo, setor, gestor, unidade, matricula,
      perfil, situacao, cargaDiaria, jornadaPadrao,
      saldoAnterior, agora, id
    ).run();

    return json({ sucesso: true, id, mensagem: 'Funcionário atualizado.' });
  }
}

// ─── Admin: Inativar Funcionário ──────────────────────────────────────────────
async function handleInativarFuncionario(db, sessao, body) {
  const id = String(body.id || '').trim();
  if (!id) throw httpError(400, 'ID é obrigatório.');

  await db.prepare(
    "UPDATE fp_usuarios SET situacao = 'INATIVO', deletado_em = ?, atualizado_em = ? WHERE id = ?"
  ).bind(nowIso(), nowIso(), id).run();

  return json({ sucesso: true, mensagem: 'Funcionário inativado.' });
}

// ─── Admin: Listar Todos os Pontos ────────────────────────────────────────────
async function handleListarTodosPontos(db, body) {
  const mesAno = String(body.mesAno || mesAnoAtual());
  const [ano, mes] = mesAno.split('-').map(Number);
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fim = `${ano}-${String(mes).padStart(2, '0')}-31`;

  const rows = await db.prepare(`
    SELECT p.*, u.nome, u.cargo, u.setor
    FROM fp_registros_ponto p
    JOIN fp_usuarios u ON u.id = p.usuario_id
    WHERE p.data >= ? AND p.data <= ?
    ORDER BY u.nome, p.data
  `).bind(inicio, fim).all();

  return json({ sucesso: true, registros: rows.results || [] });
}

// ─── Setup Admin inicial ─────────────────────────────────────────────────────
async function handleSetupAdmin(db, body, env) {
  // Só funciona se não houver nenhum admin cadastrado ainda
  const existing = await db.prepare(
    "SELECT COUNT(*) as cnt FROM fp_usuarios WHERE perfil = 'admin' AND deletado_em IS NULL"
  ).first();
  if (existing && existing.cnt > 0) {
    throw httpError(409, 'Já existe um administrador cadastrado. Use o painel admin para gerenciar usuários.');
  }

  const email = normalizeEmail(body.email);
  const senha = String(body.senha || '');
  const nome = String(body.nome || 'Administrador').trim().slice(0, 120);

  if (!email || !senha) throw httpError(400, 'Email e senha são obrigatórios.');
  if (senha.length < 8) throw httpError(400, 'A senha deve ter pelo menos 8 caracteres.');

  const adminEmail = normalizeEmail(env.ADMIN_EMAIL || '');
  if (adminEmail && email !== adminEmail) {
    throw httpError(403, 'Este email não está autorizado como administrador.');
  }

  const id = gerarId();
  const senhaHash = await hashSenha(senha);
  const agora = nowIso();

  await db.prepare(`
    INSERT INTO fp_usuarios
      (id, nome, email, senha_hash, perfil, situacao, totp_ativo, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, 'admin', 'ATIVO', 0, ?, ?)
  `).bind(id, nome, email, senhaHash, agora, agora).run();

  return json({ sucesso: true, mensagem: 'Administrador criado. Faça login para continuar.' });
}

// ─── Alterar própria senha ────────────────────────────────────────────────────
async function handleAlterarMinhaSenha(db, sessao, body) {
  const senhaAtual = String(body.senha_atual || '');
  const novaSenha = String(body.nova_senha || '');

  if (!senhaAtual || !novaSenha) throw httpError(400, 'Senha atual e nova senha são obrigatórias.');
  if (novaSenha.length < 8) throw httpError(400, 'A nova senha deve ter pelo menos 8 caracteres.');

  const usuario = await buscarUsuarioPorId(db, sessao.usuario_id);
  if (!usuario) throw httpError(404, 'Usuário não encontrado.');

  const senhaOk = await verificarSenha(senhaAtual, usuario.senha_hash);
  if (!senhaOk) throw httpError(401, 'Senha atual incorreta.');

  const novoHash = await hashSenha(novaSenha);
  await db.prepare(
    'UPDATE fp_usuarios SET senha_hash = ?, atualizado_em = ? WHERE id = ?'
  ).bind(novoHash, nowIso(), usuario.id).run();

  return json({ sucesso: true, mensagem: 'Senha alterada com sucesso.' });
}

// ─── Admin: Resetar Senha ─────────────────────────────────────────────────────
async function handleResetarSenha(db, sessao, body) {
  const id = String(body.id || '').trim();
  if (!id) throw httpError(400, 'ID é obrigatório.');

  const novaSenha = body.nova_senha || gerarSenhaTemp();
  const hash = await hashSenha(novaSenha);

  await db.prepare(
    'UPDATE fp_usuarios SET senha_hash = ?, totp_ativo = 0, totp_secret = NULL, atualizado_em = ? WHERE id = ?'
  ).bind(hash, nowIso(), id).run();

  return json({ sucesso: true, novaSenha, mensagem: 'Senha redefinida. 2FA foi desativado.' });
}

// ─── Helpers: Sessão ──────────────────────────────────────────────────────────
async function criarSessao(db, usuario, ip) {
  const token = await gerarToken();
  const expira = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000).toISOString();
  await db.prepare(
    'INSERT INTO fp_sessoes (token, usuario_id, email, perfil, criado_em, expira_em, ip) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).bind(token, usuario.id, usuario.email, usuario.perfil, nowIso(), expira, ip).run();
  return token;
}

async function validarSessao(db, token) {
  if (!token || typeof token !== 'string' || token.length < 32) return null;
  const sessao = await db.prepare(
    "SELECT * FROM fp_sessoes WHERE token = ? AND perfil != 'pendente_2fa'"
  ).bind(token).first();
  if (!sessao) return null;
  if (new Date(sessao.expira_em) < new Date()) {
    await db.prepare('DELETE FROM fp_sessoes WHERE token = ?').bind(token).run();
    return null;
  }
  return sessao;
}

// ─── Helpers: Usuários ────────────────────────────────────────────────────────
async function buscarUsuarioPorEmail(db, email) {
  return await db.prepare(
    'SELECT * FROM fp_usuarios WHERE email = ? AND deletado_em IS NULL'
  ).bind(email).first();
}

async function buscarUsuarioPorId(db, id) {
  return await db.prepare(
    'SELECT * FROM fp_usuarios WHERE id = ? AND deletado_em IS NULL'
  ).bind(id).first();
}

function sanitizarUsuario(u) {
  return {
    id: u.id, nome: u.nome, email: u.email, cargo: u.cargo,
    setor: u.setor, gestor: u.gestor, unidade: u.unidade,
    matricula: u.matricula, perfil: u.perfil, situacao: u.situacao,
    totp_ativo: !!u.totp_ativo, carga_diaria: u.carga_diaria,
    jornada_padrao: u.jornada_padrao, saldo_anterior: u.saldo_anterior || 0
  };
}

function assertAdmin(sessao) {
  if (sessao.perfil !== 'admin') throw httpError(403, 'Acesso restrito a administradores.');
}

// ─── Helpers: Rate limit ──────────────────────────────────────────────────────
async function contarTentativasRecentes(db, email, ip) {
  const desde = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
  const row = await db.prepare(
    'SELECT COUNT(*) as cnt FROM fp_login_tentativas WHERE email = ? AND sucesso = 0 AND criado_em > ?'
  ).bind(email, desde).first();
  return row ? row.cnt : 0;
}

async function registrarTentativa(db, email, ip, sucesso, motivo) {
  await db.prepare(
    'INSERT INTO fp_login_tentativas (id, email, ip, sucesso, motivo_falha, criado_em) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(gerarId(), email, ip, sucesso ? 1 : 0, motivo, nowIso()).run();
}

// ─── Helpers: Feriados ────────────────────────────────────────────────────────
async function listarFeriadosDoMes(db, ano, mes) {
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fim = `${ano}-${String(mes).padStart(2, '0')}-31`;
  const rows = await db.prepare(
    'SELECT data FROM fp_feriados WHERE data >= ? AND data <= ?'
  ).bind(inicio, fim).all();
  return new Set((rows.results || []).map(r => r.data));
}

// ─── Helpers: Registros de Ponto ─────────────────────────────────────────────
async function listarRegistrosMes(db, usuarioId, ano, mes) {
  const inicio = `${ano}-${String(mes).padStart(2, '0')}-01`;
  const fim = `${ano}-${String(mes).padStart(2, '0')}-31`;
  const rows = await db.prepare(
    'SELECT * FROM fp_registros_ponto WHERE usuario_id = ? AND data >= ? AND data <= ? ORDER BY data'
  ).bind(usuarioId, inicio, fim).all();
  const map = {};
  for (const r of (rows.results || [])) map[r.data] = r;
  return map;
}

// ─── Helpers: Cálculos de ponto ──────────────────────────────────────────────
function montarGradeMes(registros, feriados, usuario, ano, mes) {
  const diasNoMes = new Date(ano, mes, 0).getDate();
  const grade = [];

  for (let dia = 1; dia <= diasNoMes; dia++) {
    const dataStr = `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
    const dataObj = new Date(ano, mes - 1, dia);
    const tipoDia = classificarDia(dataObj, feriados);
    const reg = registros[dataStr] || {};

    const horasPrevistas = calcularHorasPrevistas(tipoDia, reg.ocorrencia, usuario.carga_diaria || 8.5);
    let horasTrabalhadas = reg.horas_trabalhadas != null ? reg.horas_trabalhadas : null;

    // Recalcular se tiver os dados brutos
    if (reg.entrada && reg.saida && horasTrabalhadas == null) {
      const intervalo = calcularIntervalo(reg.saida_almoco, reg.retorno_almoco);
      horasTrabalhadas = calcularHorasTrabalhadas(reg.entrada, reg.saida, intervalo);
    }

    const credito = (horasTrabalhadas != null && horasTrabalhadas > horasPrevistas && horasPrevistas > 0)
      ? horasTrabalhadas - horasPrevistas : 0;
    const debito = (horasTrabalhadas != null && horasTrabalhadas < horasPrevistas && horasPrevistas > 0 && (reg.entrada || reg.ocorrencia))
      ? horasPrevistas - horasTrabalhadas : 0;

    grade.push({
      data: dataStr,
      dia: diaSemana(dataObj),
      tipo_dia: tipoDia,
      entrada: reg.entrada || '',
      saida_almoco: reg.saida_almoco || '',
      retorno_almoco: reg.retorno_almoco || '',
      saida: reg.saida || '',
      ocorrencia: reg.ocorrencia || '',
      observacoes: reg.observacoes || '',
      horas_trabalhadas: horasTrabalhadas,
      horas_previstas: horasPrevistas,
      credito_bh: credito,
      debito_bh: debito,
      saldo_dia: credito - debito
    });
  }
  return grade;
}

function calcularResumoMes(registros, feriados, usuario, ano, mes) {
  const grade = montarGradeMes(registros, feriados, usuario, ano, mes);
  let diasUteis = 0, horasPrevistas = 0, horasTrabalhadas = 0;
  let credito = 0, debito = 0;

  for (const d of grade) {
    if (d.horas_previstas > 0) diasUteis++;
    horasPrevistas += d.horas_previstas;
    if (d.horas_trabalhadas != null) horasTrabalhadas += d.horas_trabalhadas;
    credito += d.credito_bh;
    debito += d.debito_bh;
  }

  const saldoMes = credito - debito;
  const saldoFinal = (usuario.saldo_anterior || 0) + saldoMes;

  return {
    mes_ano: `${String(mes).padStart(2, '0')}/${ano}`,
    dias_uteis: diasUteis,
    horas_previstas: round2(horasPrevistas),
    horas_trabalhadas: round2(horasTrabalhadas),
    credito: round2(credito),
    debito: round2(debito),
    saldo_mes: round2(saldoMes),
    saldo_anterior: usuario.saldo_anterior || 0,
    saldo_final: round2(saldoFinal)
  };
}

function classificarDia(dataObj, feriados) {
  const dow = dataObj.getDay();
  if (dow === 0 || dow === 6) return 'Fim de semana';
  const iso = dataObj.toISOString().slice(0, 10);
  if (feriados.has(iso)) return 'Feriado';
  return 'Dia útil';
}

function calcularHorasPrevistas(tipoDia, ocorrencia, cargaDiaria) {
  if (tipoDia !== 'Dia útil') return 0;
  if (ocorrencia && OCORRENCIAS_SEM_CARGA.has(ocorrencia)) return 0;
  return cargaDiaria || 8.5;
}

function calcularIntervalo(saidaAlmoco, retornoAlmoco) {
  if (!saidaAlmoco || !retornoAlmoco) return 0;
  return horaParaDecimal(retornoAlmoco) - horaParaDecimal(saidaAlmoco);
}

function calcularHorasTrabalhadas(entrada, saida, intervalo) {
  if (!entrada || !saida) return null;
  const total = horaParaDecimal(saida) - horaParaDecimal(entrada) - (intervalo || 0);
  return round2(Math.max(0, total));
}

function horaParaDecimal(hora) {
  if (!hora) return 0;
  const [h, m] = hora.split(':').map(Number);
  return h + (m || 0) / 60;
}

function diaSemana(dataObj) {
  return ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'][dataObj.getDay()];
}

function sanitizarHora(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{2}:\d{2}$/.test(s)) return s;
  return null;
}

function mesAnoAtual() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function round2(n) {
  return Math.round((n || 0) * 100) / 100;
}

// ─── Helpers: TOTP ────────────────────────────────────────────────────────────
function gerarTOTPSecret() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  for (const b of arr) secret += chars[b % 32];
  return secret;
}

function verificarTOTP(secret, codigo) {
  const now = Math.floor(Date.now() / 1000);
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const counter = Math.floor((now + delta * TOTP_PERIOD) / TOTP_PERIOD);
    const expected = gerarCodigoTOTP(secret, counter);
    if (expected === codigo.padStart(TOTP_DIGITS, '0')) return true;
  }
  return false;
}

function gerarCodigoTOTP(secret, counter) {
  // Implementação HOTP/TOTP usando Web Crypto (disponível no Workers)
  const key = base32Decode(secret);
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 0xff;
    c >>= 8;
  }
  // HMAC-SHA1 síncrono não disponível — usar implementação pura
  const hmac = hmacSHA1(key, msg);
  const offset = hmac[19] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(code % Math.pow(10, TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

function base32Decode(s) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const output = [];
  for (const c of s.toUpperCase().replace(/=+$/, '')) {
    const idx = alphabet.indexOf(c);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(output);
}

function hmacSHA1(key, msg) {
  // SHA-1 puro para HMAC
  const blockSize = 64;
  let k = key.length > blockSize ? sha1(key) : key;
  const kPad = new Uint8Array(blockSize);
  kPad.set(k);
  const ipad = kPad.map(b => b ^ 0x36);
  const opad = kPad.map(b => b ^ 0x5c);
  const inner = new Uint8Array(ipad.length + msg.length);
  inner.set(ipad); inner.set(msg, ipad.length);
  const innerHash = sha1(inner);
  const outer = new Uint8Array(opad.length + innerHash.length);
  outer.set(opad); outer.set(innerHash, opad.length);
  return sha1(outer);
}

function sha1(data) {
  let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
  const msg = new Uint8Array(data);
  const len = msg.length;
  const bitLen = len * 8;
  const padLen = len % 64 < 56 ? 56 - len % 64 : 120 - len % 64;
  const padded = new Uint8Array(len + padLen + 8);
  padded.set(msg);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLen & 0xffffffff, false);
  dv.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000), false);
  for (let i = 0; i < padded.length; i += 64) {
    const w = new Uint32Array(80);
    for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
    for (let j = 16; j < 80; j++) { const x = w[j-3]^w[j-8]^w[j-14]^w[j-16]; w[j] = (x<<1)|(x>>>31); }
    let a=h0,b=h1,c=h2,d=h3,e=h4;
    for (let j = 0; j < 80; j++) {
      let f, k;
      if (j<20){f=(b&c)|((~b)&d);k=0x5A827999;}
      else if(j<40){f=b^c^d;k=0x6ED9EBA1;}
      else if(j<60){f=(b&c)|(b&d)|(c&d);k=0x8F1BBCDC;}
      else{f=b^c^d;k=0xCA62C1D6;}
      const tmp = (((a<<5)|(a>>>27)) + f + e + k + w[j]) >>> 0;
      e=d;d=c;c=(b<<30)|(b>>>2);b=a;a=tmp;
    }
    h0=(h0+a)>>>0;h1=(h1+b)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;
  }
  const result = new Uint8Array(20);
  const rv = new DataView(result.buffer);
  rv.setUint32(0,h0,false);rv.setUint32(4,h1,false);rv.setUint32(8,h2,false);
  rv.setUint32(12,h3,false);rv.setUint32(16,h4,false);
  return result;
}

// ─── Helpers: Senha ───────────────────────────────────────────────────────────
async function hashSenha(senha) {
  // bcrypt não disponível no Workers — usar PBKDF2 via Web Crypto
  const enc = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return `pbkdf2:${saltHex}:${hashHex}`;
}

async function verificarSenha(senha, hash) {
  if (!hash || !hash.startsWith('pbkdf2:')) return false;
  const [, saltHex, storedHash] = hash.split(':');
  const salt = new Uint8Array(saltHex.match(/.{2}/g).map(b => parseInt(b, 16)));
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(senha), 'PBKDF2', false, ['deriveBits']);
  const derived = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
    keyMaterial, 256
  );
  const hashHex = Array.from(new Uint8Array(derived)).map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex === storedHash;
}

function gerarSenhaTemp() {
  const chars = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  const arr = new Uint8Array(10);
  crypto.getRandomValues(arr);
  for (const b of arr) s += chars[b % chars.length];
  return s;
}

// ─── Helpers: Utilitários ─────────────────────────────────────────────────────
async function gerarToken() {
  const arr = new Uint8Array(48);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function gerarId() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function normalizeEmail(v) {
  return String(v || '').trim().toLowerCase();
}

function nowIso() {
  return new Date().toISOString();
}

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

function jsonError(msg, status) {
  return json({ sucesso: false, erro: msg }, status);
}

function corsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}
