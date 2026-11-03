// Draws the spark mark into any <g id="rays"> (shared by pill + chat).
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  for (const g of document.querySelectorAll('g.rays')) {
    for (let i = 0; i < 8; i++) {
      const a = (Math.PI * 2 * i) / 8 + Math.PI / 8;
      const line = document.createElementNS(NS, 'line');
      line.setAttribute('x1', String(12 + Math.cos(a) * 1.4));
      line.setAttribute('y1', String(12 + Math.sin(a) * 1.4));
      line.setAttribute('x2', String(12 + Math.cos(a) * 9.2));
      line.setAttribute('y2', String(12 + Math.sin(a) * 9.2));
      g.appendChild(line);
    }
  }
})();
