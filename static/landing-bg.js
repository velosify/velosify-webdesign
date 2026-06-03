/* ============================================================
   SITEWIDE BACKGROUND — particle canvas + drifting glow.
   This file is the CANONICAL background JS, copied verbatim
   from the landing page (app.py LANDING_HTML, lines 10473-10544).
   DO NOT EDIT this to "improve" — the landing source is the
   source of truth. If the landing's particles change, copy them
   here, not the other way around.
   Used by: login, signup, legal pages, billing, CRM dashboard.
   ============================================================ */
(function landingBackground() {
  // Canvas particle background
  const canvas = document.getElementById('hero-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let width, height;
  let particles = [];
  function resize() {
    width = canvas.width = window.innerWidth;
    height = canvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resize);
  resize();
  class Particle {
    constructor() { this.reset(); }
    reset() {
      this.x = Math.random() * width;
      this.y = Math.random() * height;
      this.z = Math.random() * 3 + 1;
      this.speed = (Math.random() * 0.3 + 0.05) * (this.z / 3);
      this.opacity = Math.random() * 0.4 + 0.1;
      this.size = Math.random() * 1.5 + 0.5;
      this.color = Math.random() > 0.5 ? '#8B5CF6' : '#3B82F6';
    }
    update() {
      this.y -= this.speed;
      if (this.y < 0) this.reset();
    }
    draw() {
      ctx.fillStyle = this.color;
      ctx.globalAlpha = this.opacity;
      ctx.beginPath();
      ctx.arc(this.x, this.y, this.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }
  // Density-based particle count: scales with viewport area so the field
  // looks balanced on a 14" laptop AND a 27" desktop, without flooding
  // mobile. Floor and ceiling keep tiny screens from feeling empty and
  // ultrawide monitors from melting their GPU.
  function rebuildParticles() {
    particles = [];
    const dustTarget = Math.min(320, Math.max(140, Math.floor((width * height) / 6500)));
    for (let i = 0; i < dustTarget; i++) particles.push(new Particle());
  }
  rebuildParticles();
  // Rebuild on resize so density stays consistent if the user rotates
  // their phone or drags the window across monitors. Listeners fire in
  // bind order — the original resize() (bound above) updates width/height
  // first, then this one repopulates the field at the new dimensions.
  window.addEventListener('resize', rebuildParticles);
  function animate() {
    ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.03)';
    ctx.lineWidth = 0.5;
    const step = 80;
    for (let x = 0; x < width; x += step) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
    }
    for (let y = 0; y < height; y += step) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
    }
    particles.forEach(p => { p.update(); p.draw(); });
    requestAnimationFrame(animate);
  }
  animate();
  window.addEventListener('mousemove', (e) => {
    const moveX = (e.clientX - width / 2) / 100;
    const moveY = (e.clientY - height / 2) / 100;
    particles.forEach(p => {
      p.x += moveX * (p.z * 0.1);
      p.y += moveY * (p.z * 0.1);
    });
  });
})();
