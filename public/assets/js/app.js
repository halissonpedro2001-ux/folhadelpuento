/**
 * app.js — Cliente JavaScript do Sistema de Folha de Ponto NEW Elevadores
 * Gerencia sessão, chamadas à API e utilitários compartilhados.
 */
(function (global) {
  'use strict';

  // ── Sessão ────────────────────────────────────────────────────────────────
  const Sessao = {
    get token()  { return sessionStorage.getItem('fp_token'); },
    get perfil() { return sessionStorage.getItem('fp_perfil'); },
    get nome()   { return sessionStorage.getItem('fp_nome'); },
    isAdmin()    { return this.perfil === 'admin'; },
    isLogado()   { return !!this.token; },
    logout()     {
      if (this.token) {
        fetch('/api/ponto', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'logout', token: this.token })
        }).catch(() => {});
      }
      sessionStorage.clear();
      window.location.replace('/login.html');
    }
  };

  // ── API ───────────────────────────────────────────────────────────────────
  async function api(action, params = {}) {
    const body = { action, token: Sessao.token, ...params };
    let res;
    try {
      res = await fetch('/api/ponto', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch {
      throw new Error('Sem conexão com o servidor. Verifique sua internet.');
    }

    const data = await res.json().catch(() => ({}));

    if (res.status === 401) {
      sessionStorage.clear();
      window.location.replace('/login.html');
      return;
    }

    if (!data.sucesso) {
      throw new Error(data.erro || 'Erro na operação.');
    }

    return data;
  }

  // ── UI Utilitários ────────────────────────────────────────────────────────
  const UI = {
    el(tag, attrs = {}, children = []) {
      const el = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k.startsWith('on')) el[k] = v;
        else el.setAttribute(k, v);
      }
      for (const c of children) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); }
      return el;
    },

    $(id) { return document.getElementById(id); },

    showAlert(el, msg, tipo = 'error') {
      if (!el) return;
      el.textContent = msg;
      el.className = `alert alert-${tipo}`;
    },

    hideAlert(el) {
      if (el) el.className = 'alert hidden';
    },

    formatHoras(h) {
      if (h == null || h === '') return '—';
      const total = Math.round(h * 60);
      const hh = Math.floor(Math.abs(total) / 60);
      const mm = Math.abs(total) % 60;
      const sinal = total < 0 ? '-' : '';
      return `${sinal}${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    },

    formatSaldo(h) {
      if (h == null) return '<span class="saldo-zer">—</span>';
      const f = UI.formatHoras(h);
      if (h > 0.01) return `<span class="saldo-pos">+${f}</span>`;
      if (h < -0.01) return `<span class="saldo-neg">${f}</span>`;
      return `<span class="saldo-zer">${f}</span>`;
    },

    badgeTipoDia(tipo) {
      const map = {
        'Dia útil':    ['util',    'Dia útil'],
        'Fim de semana': ['fds',   'Fim de semana'],
        'Feriado':     ['feriado', 'Feriado']
      };
      const [cls, label] = map[tipo] || ['fds', tipo];
      return `<span class="badge ${cls}">${label}</span>`;
    },

    modal({ title, body, footer }) {
      const overlay = UI.el('div', { class: 'modal-overlay' });
      const box = UI.el('div', { class: 'modal-box' });

      const header = UI.el('div', { class: 'modal-header' });
      header.appendChild(UI.el('h2', { text: title }));
      const closeBtn = UI.el('button', { class: 'modal-close', text: '✕', type: 'button' });
      closeBtn.onclick = () => overlay.remove();
      header.appendChild(closeBtn);

      box.appendChild(header);
      box.appendChild(body);

      if (footer) {
        const f = UI.el('div', { class: 'modal-footer' });
        for (const btn of footer) {
          const b = UI.el('button', {
            class: `btn ${btn.class || 'btn-secondary'}`,
            text: btn.label,
            type: 'button'
          });
          b.onclick = () => { if (btn.action) btn.action(overlay); else overlay.remove(); };
          f.appendChild(b);
        }
        box.appendChild(f);
      }

      overlay.appendChild(box);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
      document.body.appendChild(overlay);
      return overlay;
    },

    confirm(msg) {
      return new Promise(resolve => {
        const body = UI.el('p', { text: msg, style: 'color: var(--text); font-size: .95rem;' });
        const m = UI.modal({
          title: 'Confirmar',
          body,
          footer: [
            { label: 'Cancelar', class: 'btn-secondary', action: (o) => { o.remove(); resolve(false); } },
            { label: 'Confirmar', class: 'btn-danger', action: (o) => { o.remove(); resolve(true); } }
          ]
        });
      });
    }
  };

  // ── Meses ─────────────────────────────────────────────────────────────────
  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
                 'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

  function mesAnoAtual() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function formatarMesAno(mesAno) {
    const [ano, mes] = mesAno.split('-');
    return `${MESES[parseInt(mes) - 1]} ${ano}`;
  }

  function gerarOpcoesMeses(selectEl, valorAtual) {
    const d = new Date();
    const opcoes = [];
    for (let i = -3; i <= 1; i++) {
      const dt = new Date(d.getFullYear(), d.getMonth() + i, 1);
      const val = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
      opcoes.push({ val, label: formatarMesAno(val) });
    }
    selectEl.innerHTML = opcoes.map(o =>
      `<option value="${o.val}" ${o.val === valorAtual ? 'selected' : ''}>${o.label}</option>`
    ).join('');
  }

  // ── Exportar ──────────────────────────────────────────────────────────────
  global.FP = { Sessao, api, UI, MESES, mesAnoAtual, formatarMesAno, gerarOpcoesMeses };

})(window);
