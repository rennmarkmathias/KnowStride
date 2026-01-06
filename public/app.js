(() => {
  const $ = (id) => document.getElementById(id);

  const clerkRoot = $("clerkRoot");
  const authError = $("authError");
  const logoutBtn = $("logoutBtn");

  function setError(msg) {
    if (authError) authError.textContent = msg || "";
  }

  async function fetchConfig() {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) throw new Error(`Failed to fetch /api/config (${res.status})`);
    return res.json();
  }

  function loadScriptSequential(urls, attrs = {}) {
    return new Promise((resolve, reject) => {
      let i = 0;

      const tryNext = () => {
        if (i >= urls.length) {
          reject(new Error("All Clerk script URLs failed to load"));
          return;
        }

        const url = urls[i++];
        const s = document.createElement("script");
        s.src = url;
        s.async = true;

        // Lägg på attribut (t.ex. publishable key) om vi vill.
        Object.entries(attrs).forEach(([k, v]) => {
          if (v != null) s.setAttribute(k, String(v));
        });

        s.onload = () => resolve(url);
        s.onerror = () => {
          // Ta bort trasigt script och prova nästa
          s.remove();
          tryNext();
        };

        document.head.appendChild(s);
      };

      tryNext();
    });
  }

  async function init() {
    setError("");

    if (!clerkRoot) {
      // Om HTML ändrats och vi saknar root: faila snällt.
      console.error("Missing #clerkRoot element");
      return;
    }

    let cfg;
    try {
      cfg = await fetchConfig();
    } catch (e) {
      console.error(e);
      setError("Kunde inte hämta konfigurationen (/api/config).");
      return;
    }

    const publishableKey = cfg?.clerkPublishableKey;
    if (!publishableKey) {
      setError("Saknar Clerk publishable key från /api/config.");
      return;
    }

    // Viktigt: vi försöker flera källor så vi inte dör om js.clerk.com inte resolvar.
    const scriptUrls = [
      "https://js.clerk.com/v4/clerk.browser.js",
      "https://cdn.jsdelivr.net/npm/@clerk/clerk-js@4/dist/clerk.browser.js",
      "/vendor/clerk.browser.js", // valfri lokal fallback om du lägger den senare
    ];

    try {
      await loadScriptSequential(scriptUrls);
    } catch (e) {
      console.error(e);
      setError(
        "Inloggningen kunde inte laddas (Clerk script). " +
        "Det verkar som att Clerk-CDN inte nås från ditt nät just nu."
      );
      return;
    }

    if (!window.Clerk) {
      setError("Clerk script laddades men window.Clerk finns inte (oväntat).");
      return;
    }

    try {
      // Init + load
      window.Clerk.configure({ publishableKey });
      await window.Clerk.load();

      // Mounta sign-in UI
      clerkRoot.innerHTML = "";
      window.Clerk.mountSignIn(clerkRoot, {
        // håll enkelt: stanna på /app efter inlogg
        redirectUrl: "/app",
        afterSignInUrl: "/app",
        // Vi vill bara Google + email (du sa att Apple inte ska finnas)
        // Själva providers styrs i Clerk Dashboard, men detta gör UI:t rent.
        appearance: {
          elements: {
            // tomt - behåll default
          },
        },
      });

      // Logout-knapp om du vill använda den
      if (logoutBtn) {
        logoutBtn.style.display = "inline-block";
        logoutBtn.onclick = async () => {
          try {
            await window.Clerk.signOut();
            location.href = "/app";
          } catch (e) {
            console.error(e);
          }
        };
      }
    } catch (e) {
      console.error(e);
      setError("Clerk kunde inte initieras. Kolla Console för detaljer.");
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
