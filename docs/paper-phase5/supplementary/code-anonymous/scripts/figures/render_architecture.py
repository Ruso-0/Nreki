from pathlib import Path

import matplotlib.pyplot as plt
import seaborn as sns
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch


ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "paper-phase5" / "figures"
OUT.mkdir(parents=True, exist_ok=True)
COLORBLIND = sns.color_palette("colorblind").as_hex()


def box(ax, xy, w, h, text, face="#eef4ff", edge="#234a7a", fontsize=10):
    patch = FancyBboxPatch(
        xy,
        w,
        h,
        boxstyle="round,pad=0.02,rounding_size=0.035",
        linewidth=1.6,
        edgecolor=edge,
        facecolor=face,
    )
    ax.add_patch(patch)
    ax.text(
        xy[0] + w / 2,
        xy[1] + h / 2,
        text,
        ha="center",
        va="center",
        fontsize=fontsize,
        color="#172033",
        wrap=True,
    )
    return patch


def arrow(ax, start, end, color="#34495e", rad=0.0):
    ax.add_patch(
        FancyArrowPatch(
            start,
            end,
            arrowstyle="-|>",
            mutation_scale=16,
            linewidth=1.5,
            color=color,
            connectionstyle=f"arc3,rad={rad}",
        )
    )


def render():
    fig, ax = plt.subplots(figsize=(12, 6.8))
    ax.set_xlim(0, 12)
    ax.set_ylim(0, 7)
    ax.axis("off")

    ax.text(
        6,
        6.62,
        "Late-Fusion T-RAG Retrieval Pipeline",
        ha="center",
        va="center",
        fontsize=17,
        fontweight="bold",
        color="#111827",
    )

    box(ax, (0.55, 4.55), 2.55, 1.05, "Repository\nAST + dependencies", "#f5f7fa", "#58606d")
    box(ax, (3.75, 5.25), 2.35, 0.95, "NREKI Type Ledger\ntopological signals\n(topK*4=40)", "#e8f6ef", COLORBLIND[2])
    box(ax, (3.75, 3.65), 2.35, 0.95, "BM25 lexical\nmatching\n(topK*4=40)", "#fff2e6", COLORBLIND[1])
    box(ax, (7.0, 4.45), 2.25, 1.15, "RRF Fusion\nfile-level\nsum 1/(60+rank)", "#edf2ff", COLORBLIND[0])
    box(ax, (9.95, 4.55), 1.55, 0.95, "Top-K=10\nfused files", "#f8f0fc", COLORBLIND[4])
    box(ax, (7.0, 2.35), 2.35, 1.0, "Chunk mapping\nNREKI prefer\nBM25 fallback", "#e7f5ff", COLORBLIND[9])
    box(ax, (9.9, 2.35), 1.75, 1.0, "Local MCP\nprotocol", "#f1f3f5", "#495057")
    box(ax, (9.9, 0.85), 1.75, 0.9, "Coding agent", "#fff5f5", "#c92a2a")

    ax.text(4.95, 6.35, "Stage 1: parallel retrieval", ha="center", fontsize=10, color="#495057")
    ax.text(8.12, 5.85, "Stage 2: reciprocal rank fusion", ha="center", fontsize=10, color="#495057")
    ax.text(8.15, 3.55, "Stage 3: chunk mapping", ha="center", fontsize=10, color="#495057")

    arrow(ax, (3.1, 5.05), (3.75, 5.75))
    arrow(ax, (3.1, 5.05), (3.75, 4.15))
    arrow(ax, (6.1, 5.72), (7.0, 5.05))
    arrow(ax, (6.1, 4.12), (7.0, 4.95))
    arrow(ax, (9.25, 5.03), (9.95, 5.03))
    arrow(ax, (10.73, 4.55), (8.18, 3.35), rad=-0.18)
    arrow(ax, (9.35, 2.85), (9.9, 2.85))
    arrow(ax, (10.78, 2.35), (10.78, 1.75))

    ax.text(
        6,
        0.22,
        "Deterministic tie-breaking: descending RRF score, then lexicographic file path order.",
        ha="center",
        fontsize=9,
        color="#495057",
    )

    fig.tight_layout()
    fig.savefig(OUT / "architecture.pdf", bbox_inches="tight")
    fig.savefig(OUT / "architecture.png", dpi=300, bbox_inches="tight")
    plt.close(fig)


if __name__ == "__main__":
    render()
