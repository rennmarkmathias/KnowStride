// public/js/library.js

export async function loadLibrary() {
  const statusEl = document.getElementById("library-status");

  try {
    const res = await fetch("/api/library", {
      credentials: "include"
    });

    if (res.status === 401) {
      showPlans();
      return;
    }

    const data = await res.json();

    if (data?.hasAccess) {
      showLibrary();
    } else {
      showPlans();
    }
  } catch (err) {
    console.error("Library load error", err);
    showPlans();
  }
}

function showLibrary() {
  document.getElementById("library-content").style.display = "block";
  document.getElementById("plans").style.display = "none";
}

function showPlans() {
  document.getElementById("library-content").style.display = "none";
  document.getElementById("plans").style.display = "block";
}
