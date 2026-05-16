from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "paper-phase5" / "figures"
OUT.mkdir(parents=True, exist_ok=True)


COLORBLIND = sns.color_palette("colorblind").as_hex()
POINTS = [
    ("NREKI standalone", 2313, 0.414, COLORBLIND[2]),
    ("BM25 standalone", 11110, 0.374, COLORBLIND[1]),
    ("Hybrid RRF", 4588, 0.566, COLORBLIND[0]),
]


def render():
    sns.set_theme(style="whitegrid", context="paper")
    fig, ax = plt.subplots(figsize=(8.6, 5.8))

    for label, tokens, fhr, color in POINTS:
        ax.scatter(tokens, fhr, s=150, color=color, edgecolor="white", linewidth=1.6, zorder=3)
        dx = -25 if label == "BM25 standalone" else 18
        ha = "right" if label == "BM25 standalone" else "left"
        ax.annotate(
            f"{label}\n{tokens:,} tok, FHR {fhr:.3f}",
            (tokens, fhr),
            xytext=(dx, 14),
            textcoords="offset points",
            ha=ha,
            fontsize=10,
            color="#172033",
            bbox=dict(boxstyle="round,pad=0.25", fc="white", ec="#ced4da", alpha=0.92),
        )

    frontier_x = [11110, 4588, 2313]
    frontier_y = [0.374, 0.566, 0.414]
    ax.plot(frontier_x, frontier_y, linestyle=":", color="#495057", linewidth=1.6, label="Observed frontier")

    ax.set_xscale("log")
    ax.invert_xaxis()
    ax.set_ylim(0.0, 1.0)
    ax.set_xlabel("Median token cost, log scale (lower cost to the right)", fontsize=11)
    ax.set_ylabel("First-Hit Recall", fontsize=11)
    ax.set_title("Token Efficiency vs First-Hit Recall (PolyBench-Verified N=99)", fontsize=13, weight="bold")
    ax.legend(loc="lower right", frameon=True)
    ax.grid(True, which="both", linestyle="-", linewidth=0.5, alpha=0.35)

    ax.text(
        0.03,
        0.96,
        "voyage-code-3 omitted: 15.2% completion rate makes N=99 token comparison non-equivalent",
        transform=ax.transAxes,
        ha="left",
        va="top",
        fontsize=9,
        color="#495057",
    )

    fig.tight_layout()
    fig.savefig(OUT / "pareto_frontier.pdf", bbox_inches="tight")
    fig.savefig(OUT / "pareto_frontier.png", dpi=300, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    render()
