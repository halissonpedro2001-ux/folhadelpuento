# Arquitetura — Sistema Folha de Ponto NEW Elevadores

## Decisões de arquitetura

- **Plataforma**: Cloudflare Pages + Pages Functions (Workers) + D1 (SQLite)
- **Autenticação**: Login próprio (email + senha bcrypt) + TOTP 2FA (Google Authenticator compatível)
- **Frontend**: HTML/CSS/JS puro (sem framework), estilo visual consistente com sistema-integrado-new
- **Backend**: Cloudflare Pages Functions (JavaScript ES modules)
- **Banco**: D1 `sistema-new` (database_id: 5eb7fdb4-27e9-4a72-9d0e-1dd8a2f3cc42)
- **Deploy**: GitHub Actions → Cloudflare Pages (projeto: `folha-de-ponto`)

## Tabelas D1 novas (adicionadas ao schema existente)

### fp_usuarios
Funcionários com acesso ao sistema de ponto.

### fp_sessoes
Sessões autenticadas (token JWT-like armazenado no D1).

### fp_totp_secrets
Segredos TOTP por usuário para 2FA.

### fp_registros_ponto
Registros diários de ponto (entrada, saída almoço, retorno, saída, ocorrência, observações).

### fp_feriados
Feriados cadastrados (espelhando a aba Feriados da planilha).

## Fluxo de autenticação

1. Usuário acessa `/login` → digita email + senha
2. Backend valida credenciais → se 2FA ativo, redireciona para `/verificar-2fa`
3. Usuário digita código TOTP de 6 dígitos
4. Backend valida código → cria sessão → redireciona para `/dashboard`
5. Sessão expira em 8h (jornada de trabalho)

## Telas

- `/login` — formulário de email + senha
- `/verificar-2fa` — formulário de código TOTP
- `/dashboard` — resumo do mês atual do funcionário logado
- `/ponto` — tabela de registro de ponto do mês
- `/configurar-2fa` — QR code para configurar Google Authenticator (primeiro acesso)
- `/admin` — painel admin: listar funcionários, criar contas, ver todos os pontos

## Perfis

- `admin` — acesso total, pode criar/editar funcionários, ver todos os pontos
- `funcionario` — acessa apenas seus próprios registros de ponto
