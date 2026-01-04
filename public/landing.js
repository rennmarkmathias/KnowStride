document.querySelectorAll(".plan").forEach(btn => {
  btn.addEventListener("click", () => {
    const plan = btn.getAttribute("data-plan");
    window.location.href = `/app.html?plan=${encodeURIComponent(plan)}`;
  });
});
