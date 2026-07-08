# Sistema de Folha de Ponto — NEW Elevadores

Sistema web para controle de ponto e banco de horas dos colaboradores da NEW Elevadores e Escadas Rolantes Ltda, com autenticação própria e verificação em duas etapas (2FA/TOTP).

## Funcionalidades

- **Login seguro** com email e senha (PBKDF2 + salt)
- **Verificação em duas etapas** (TOTP — compatível com Google Authenticator, Authy)
- **Folha de ponto mensal** com registro de entrada, saída, intervalo e ocorrências
- **Banco de horas** com cálculo automático de crédito, débito e saldo
- **Dashboard** com resumo mensal do colaborador
- **Painel administrativo** para gerenciar funcionários e visualizar todos os pontos
- **Feriados** pré-cadastrados para 2026 (nacionais + pontos facultativos)
- **Rate limiting** para proteção contra ataques de força bruta

## Estrutura

```
folhadelpuento/
├── public/
│   ├── index.html           — Dashboard principal
│   ├── login.html           — Tela de login
│   ├── verificar-2fa.html   — Verificação de código TOTP
│   ├── configurar-2fa.html  — Configurar/ativar 2FA
│   ├── ponto.html           — Folha de ponto mensal
│   ├── admin.html           — Painel administrativo
│   ├── _headers             — Headers de segurança
│   ├── _redirects           — Regras de redirecionamento
│   └── assets/
│       ├── css/app.css      — Estilos globais
│       └── js/app.js        — Cliente JavaScript
├── functions/
│   └── api/
│       └── ponto.js         — Backend (Cloudflare Pages Functions)
├── schema.sql               — Schema D1 (idempotente)
├── wrangler.jsonc           — Configuração Cloudflare
└── .github/workflows/       — Deploy automático
```

## Deploy no Cloudflare Pages

### Pré-requisitos

1. Banco D1 `sistema-new` já existente (database_id: `5eb7fdb4-27e9-4a72-9d0e-1dd8a2f3cc42`)
2. Secrets no GitHub: `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_ACCOUNT_ID`

### Passos

1. **Criar o projeto Pages** no Cloudflare Dashboard:
   - Nome: `folha-de-ponto`
   - Framework: None
   - Build output: `public`
   - Functions: `functions`

2. **Vincular o banco D1** nas configurações do projeto Pages:
   - Variable name: `DB`
   - D1 database: `sistema-new`

3. **Aplicar o schema** no banco D1:
   ```bash
   wrangler d1 execute sistema-new --remote --file=schema.sql
   ```

4. **Criar o primeiro usuário admin** diretamente no D1:
   ```sql
   -- Gerar hash de senha via endpoint /api/ponto (action: criarAdmin)
   -- Ou inserir via wrangler d1 execute após gerar o hash
   ```

5. **Push para main** — o GitHub Actions fará o deploy automaticamente.

## Criar primeiro usuário admin

Acesse o Cloudflare Dashboard > D1 > sistema-new > Console e execute:

```sql
-- Primeiro, use o endpoint de setup inicial (apenas uma vez):
-- POST /api/ponto { "action": "setupAdmin", "email": "admin@empresa.com", "senha": "SuaSenha123" }
```

Ou via wrangler:
```bash
wrangler d1 execute sistema-new --remote --command "
INSERT INTO fp_usuarios (id, nome, email, senha_hash, perfil, situacao, criado_em, atualizado_em)
VALUES ('admin-001', 'Administrador', 'halissonpedro2001@gmail.com', 'TROCAR_PELO_HASH', 'admin', 'ATIVO', datetime('now'), datetime('now'));
"
```

## Banco de dados

O sistema usa o banco D1 `sistema-new` já existente no projeto `sistema-integrado-new`.
As tabelas do sistema de ponto têm prefixo `fp_` para não conflitar com as tabelas existentes.

## Segurança

- Senhas armazenadas com PBKDF2-SHA256 (100.000 iterações + salt aleatório)
- Tokens de sessão de 96 bytes gerados com `crypto.getRandomValues`
- Rate limiting: máximo 5 tentativas de login em 15 minutos por email
- Sessões expiram em 8 horas
- Headers de segurança configurados no `_headers`
- 2FA via TOTP (RFC 6238) — compatível com Google Authenticator, Authy, Microsoft Authenticator
