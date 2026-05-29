// TruthLens — popup.js

document.addEventListener("DOMContentLoaded", () => {
  loadStats();
  setupToggle();
  setupReportsBtn();
  checkActiveTab();
});

function loadStats() {
  chrome.storage.local.get(["stats", "reports"], (data) => {
    const stats = data.stats || { scanned: 0, safe: 0, verify: 0, fake: 0 };
    const reports = data.reports || [];

    document.getElementById("statScanned").textContent = stats.scanned;
    document.getElementById("statSafe").textContent = stats.safe;
    document.getElementById("statVerify").textContent = stats.verify;
    document.getElementById("statFake").textContent = stats.fake + reports.length;
  });
}

function setupToggle() {
  const toggle = document.getElementById("activeToggle");

  chrome.storage.local.get(["isActive"], (data) => {
    toggle.checked = data.isActive !== false; // default true
  });

  toggle.addEventListener("change", () => {
    chrome.storage.local.set({ isActive: toggle.checked });
  });
}

function setupReportsBtn() {
  document.getElementById("viewReports").addEventListener("click", () => {
    chrome.storage.local.get(["reports"], (data) => {
      const reports = data.reports || [];
      if (reports.length === 0) {
        alert("No community reports yet.");
        return;
      }
      const summary = reports
        .slice(-5)
        .map(r => `• ${r.verdict} — ${r.caption?.slice(0, 40) || "Unknown post"}...`)
        .join("\n");
      alert(`Last ${Math.min(5, reports.length)} Reports:\n\n${summary}`);
    });
  });
}

function checkActiveTab() {
  const dot = document.getElementById("statusDot");

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const url = tabs[0]?.url || "";
    if (url.includes("instagram.com")) {
      dot.classList.add("active");
      dot.title = "Active on this page";
    } else {
      dot.classList.add("inactive");
      dot.title = "Only works on Instagram";
    }
  });
}
