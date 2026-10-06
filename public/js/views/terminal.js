'use strict';
/* Terminal view: xterm.js over Socket.IO */
window.TerminalView = (() => {
  let socket = null;
  let term = null;
  let fit = null;
  let observer = null;

  function render(root) {
    const warn = ui.el('div', { class: 'banner' },
      '⚠ This shell runs with the panel\'s privileges (usually root). Be careful.');
    const box = ui.el('div', { id: 'terminalContainer' });
    root.append(warn, box);

    term = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      theme: { background: '#050b16', foreground: '#e2e8f0', cursor: '#34d399' }
    });
    fit = new FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open(box);
    fit.fit();

    socket = io('/terminal');
    socket.on('connect', () => socket.emit('resize', { cols: term.cols, rows: term.rows }));
    socket.on('data', (d) => term.write(d));
    socket.on('connect_error', () => term.write('\r\n[letzControl] Not authorized or server unavailable.\r\n'));
    term.onData((d) => socket.emit('data', d));

    observer = new ResizeObserver(() => {
      try {
        fit.fit();
        socket.emit('resize', { cols: term.cols, rows: term.rows });
      } catch { /* not visible */ }
    });
    observer.observe(box);
    term.focus();
  }

  function destroy() {
    if (observer) { observer.disconnect(); observer = null; }
    if (socket) { socket.disconnect(); socket = null; }
    if (term) { term.dispose(); term = null; }
  }

  return { render, destroy };
})();
