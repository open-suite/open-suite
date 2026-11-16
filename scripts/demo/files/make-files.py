"""Regenerate the curated demo Office files in this directory.

seed-demo.sh uploads every .docx/.xlsx/.pptx here to johndoe's Nextcloud root
on each daily reset. The content matches the rest of the demo story (Q3 deck
review with Jane, the website launch board, the morning standup).

    python3 -m venv .venv && .venv/bin/pip install python-docx openpyxl python-pptx
    .venv/bin/python make-files.py
"""

from pathlib import Path

from docx import Document
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from pptx import Presentation
from pptx.util import Pt

HERE = Path(__file__).resolve().parent


def planning_notes() -> None:
    doc = Document()
    doc.add_heading("Q3 planning notes", 0)
    doc.add_paragraph("Owner: John Doe · Reviewers: Jane Doe, People Operations")
    doc.add_heading("Goals", level=1)
    for goal in (
        "Launch the new Open Suite website before the end of the quarter.",
        "Move the whole team onto shared calendars, chat and video calls.",
        "Keep every file and conversation hosted in the EU.",
    ):
        doc.add_paragraph(goal, style="List Number")
    doc.add_heading("Open questions", level=1)
    for question in (
        "Do we need a second review round for the accessibility checks?",
        "Who presents the budget slide at the Q3 deck review?",
    ):
        doc.add_paragraph(question, style="List Bullet")
    doc.add_heading("Next steps", level=1)
    doc.add_paragraph(
        "Jane adds her comments to the Q3 deck. John reviews the final two slides "
        "before Thursday's meeting and updates the budget sheet."
    )
    doc.save(HERE / "Q3 planning notes.docx")


def budget() -> None:
    wb = Workbook()
    ws = wb.active
    ws.title = "Q3 budget"
    header = ["Item", "July", "August", "September", "Q3 total"]
    rows = [
        ("Hosting (EU region)", 420, 420, 420),
        ("Laptop renewals", 0, 2400, 0),
        ("Website launch", 600, 900, 1500),
        ("Training", 250, 0, 250),
    ]
    ws.append(header)
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="0B1F33")
    for index, (item, *months) in enumerate(rows, start=2):
        ws.append([item, *months, f"=SUM(B{index}:D{index})"])
    total_row = len(rows) + 2
    ws.append(["Total", *(f"=SUM({col}2:{col}{total_row - 1})" for col in "BCDE")])
    for cell in ws[total_row]:
        cell.font = Font(bold=True)
    ws.column_dimensions["A"].width = 24
    for col in "BCDE":
        ws.column_dimensions[col].width = 12
    wb.save(HERE / "Q3 budget.xlsx")


def deck() -> None:
    prs = Presentation()
    title = prs.slides.add_slide(prs.slide_layouts[0])
    title.shapes.title.text = "Q3 deck review"
    title.placeholders[1].text = "John Doe and Jane Doe"
    for heading, bullets in (
        ("Where we are", ["Website launch board: 2 of 5 tasks done", "Team mail and chat live for everyone"]),
        ("Budget", ["Q3 spend tracked in Q3 budget.xlsx", "Laptop renewals approved by Procurement"]),
        ("Next steps", ["Finish the accessibility review", "Publish the launch announcement"]),
    ):
        slide = prs.slides.add_slide(prs.slide_layouts[1])
        slide.shapes.title.text = heading
        body = slide.placeholders[1].text_frame
        body.text = bullets[0]
        for bullet in bullets[1:]:
            body.add_paragraph().text = bullet
        for paragraph in body.paragraphs:
            for run in paragraph.runs:
                run.font.size = Pt(24)
    prs.save(HERE / "Q3 deck review.pptx")


if __name__ == "__main__":
    planning_notes()
    budget()
    deck()
