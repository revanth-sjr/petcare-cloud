/* =====================================================================
   kpi.js — live metrics, computed from real logs.
   Pod A owns this file.
   ---------------------------------------------------------------------
   A KPI on a slide is a claim. A KPI on screen, recomputing as you log a
   task in front of the judges, is a demonstration. Label everything as a
   prototype measurement and say so out loud.
   ===================================================================== */

import { $ } from "./ui.js";
import { computeKpis } from "./data.js";

let chart = null;

export function render(state) {
  const k = computeKpis(state);

  const tiles = [
    { label: "Completion",  value: `${k.completionRate}%`,      tone: tone(k.completionRate) },
    { label: "Adherence",   value: `${k.medicationAdherence}%`, tone: tone(k.medicationAdherence) },
    { label: "Missed",      value: k.missedTasks,               tone: k.missedTasks > 0 ? "bad" : "good" },
    { label: "By caretaker", value: `${k.caretakerShare}%`,     tone: "" }
  ];

  $("#kpiGrid").innerHTML = tiles.map((t) => `
    <div class="kpi ${t.tone}">
      <b>${t.value}</b>
      <span>${t.label}</span>
    </div>`).join("");

  drawChart(k.history);
}

const tone = (pct) => (pct >= 80 ? "good" : pct < 50 ? "bad" : "");

function drawChart(history) {
  const canvas = $("#kpiChart");
  if (!canvas) return;

  /* Chart.js comes from a CDN. If it did not load — offline venue, blocked
     network — hide the canvas rather than leaving a blank rectangle, and
     say why. The KPI tiles above still work. */
  if (typeof Chart === "undefined") {
    canvas.hidden = true;
    if (!$("#kpiChartNote")) {
      const p = document.createElement("p");
      p.id = "kpiChartNote";
      p.className = "empty";
      p.style.fontSize = "12px";
      p.textContent = "Trend chart unavailable — Chart.js could not load.";
      canvas.parentNode.appendChild(p);
    }
    return;
  }

  const labels = history.map((h) => h.dayKey.slice(8) + "/" + h.dayKey.slice(5, 7));
  const data   = history.map((h) => h.rate);

  if (chart) {
    chart.data.labels = labels;
    chart.data.datasets[0].data = data;
    chart.update("none");
    return;
  }

  chart = new Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: "Completion rate",
        data,
        backgroundColor: data.map((v, i) =>
          i === data.length - 1 ? "#14706B" : "rgba(20,112,107,.28)"),
        borderRadius: 4,
        borderSkipped: false,
        barPercentage: 0.72
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: { label: (c) => `${c.parsed.y}% of scheduled care completed` }
        }
      },
      scales: {
        y: {
          beginAtZero: true, max: 100,
          ticks: { stepSize: 50, color: "#7B8D87", font: { size: 10 }, callback: (v) => v + "%" },
          grid: { color: "#EDF2F0", drawTicks: false }
        },
        x: {
          ticks: { color: "#7B8D87", font: { size: 10 } },
          grid: { display: false }
        }
      }
    }
  });
}
