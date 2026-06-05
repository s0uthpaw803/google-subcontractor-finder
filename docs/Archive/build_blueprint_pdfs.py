from pathlib import Path
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer


DOCS_DIR = Path("/Users/mcdowell/Desktop/temp files/Keystone Connect/docs")


def build_styles():
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="KCBody",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=10.5,
            leading=14,
            textColor=colors.HexColor("#222222"),
            alignment=TA_LEFT,
            spaceAfter=6,
        )
    )
    styles.add(
        ParagraphStyle(
            name="KCTitle",
            parent=styles["Title"],
            fontName="Helvetica-Bold",
            fontSize=20,
            leading=24,
            textColor=colors.HexColor("#111111"),
            spaceAfter=14,
        )
    )
    styles.add(
        ParagraphStyle(
            name="KCHeading1",
            parent=styles["Heading1"],
            fontName="Helvetica-Bold",
            fontSize=15,
            leading=18,
            textColor=colors.HexColor("#be1e2d"),
            spaceBefore=10,
            spaceAfter=8,
        )
    )
    styles.add(
        ParagraphStyle(
            name="KCHeading2",
            parent=styles["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12,
            leading=15,
            textColor=colors.HexColor("#333333"),
            spaceBefore=8,
            spaceAfter=4,
        )
    )
    styles.add(
        ParagraphStyle(
            name="KCBullet",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=10.5,
            leading=14,
            leftIndent=16,
            firstLineIndent=-8,
            bulletIndent=0,
            spaceAfter=3,
            textColor=colors.HexColor("#222222"),
        )
    )
    styles.add(
        ParagraphStyle(
            name="KCNumber",
            parent=styles["BodyText"],
            fontName="Helvetica",
            fontSize=10.5,
            leading=14,
            leftIndent=16,
            firstLineIndent=-12,
            spaceAfter=3,
            textColor=colors.HexColor("#222222"),
        )
    )
    return styles


def escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def markdown_to_story(md_path: Path):
    styles = build_styles()
    story = []
    lines = md_path.read_text(encoding="utf-8").splitlines()
    for raw in lines:
        line = raw.rstrip()
        if not line.strip():
            story.append(Spacer(1, 0.08 * inch))
            continue
        if line.startswith("# "):
            story.append(Paragraph(escape(line[2:].strip()), styles["KCTitle"]))
            continue
        if line.startswith("## "):
            story.append(Paragraph(escape(line[3:].strip()), styles["KCHeading1"]))
            continue
        if line.startswith("### "):
            story.append(Paragraph(escape(line[4:].strip()), styles["KCHeading2"]))
            continue
        if line.startswith("- "):
            story.append(Paragraph(escape(line[2:].strip()), styles["KCBullet"], bulletText="•"))
            continue
        stripped = line.lstrip()
        if stripped[:2].isdigit() and stripped[2:3] == ".":
            story.append(Paragraph(escape(stripped), styles["KCNumber"]))
            continue
        story.append(Paragraph(escape(line), styles["KCBody"]))
    return story


def build_pdf(source_name: str, output_name: str):
    src = DOCS_DIR / source_name
    out = DOCS_DIR / output_name
    doc = SimpleDocTemplate(
        str(out),
        pagesize=letter,
        leftMargin=0.7 * inch,
        rightMargin=0.7 * inch,
        topMargin=0.75 * inch,
        bottomMargin=0.75 * inch,
        title=source_name,
        author="Codex",
    )
    story = markdown_to_story(src)
    doc.build(story)


if __name__ == "__main__":
    builds = [
        (
            "Production-Technical-Blueprint.md",
            "Production-Technical-Blueprint.pdf",
        ),
        (
            "Production-Technical-Blueprint-First-Person.md",
            "Production-Technical-Blueprint-First-Person.pdf",
        ),
        (
            "Production-Technical-Blueprint-Executive-Summary.md",
            "Production-Technical-Blueprint-Executive-Summary.pdf",
        ),
        (
            "Keystone-Connect-One-Pager-Plain-English.md",
            "Keystone-Connect-One-Pager-Plain-English.pdf",
        ),
        (
            "Quick-Guide-Plain-English.md",
            "Keystone-Connect-Super-Simple-Guide.pdf",
        ),
        (
            "Public-Release-FAQ.md",
            "Public-Release-FAQ.pdf",
        ),
    ]
    for source_name, output_name in builds:
        build_pdf(source_name, output_name)
