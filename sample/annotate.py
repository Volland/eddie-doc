"""Synthesize an editor-annotated PDF for testing extraction.

Adds real PDF markup annotations (highlight, strikeout, sticky-note comment)
onto the asciidoctor-generated PDF by searching for phrases in the rendered
text. This mimics what a human editor's tool would produce.
"""
import sys
import fitz  # PyMuPDF

src, dst = sys.argv[1], sys.argv[2]
doc = fitz.open(src)


def find(text):
    for page in doc:
        rects = page.search_for(text)
        if rects:
            return page, rects
    return None, None


def highlight(text, comment, author="Editor"):
    page, rects = find(text)
    if not rects:
        print(f"!! not found (highlight): {text!r}")
        return
    a = page.add_highlight_annot(rects)
    a.set_info(content=comment, title=author)
    a.update()
    print(f"highlight  p{page.number+1}: {text!r}")


def strikeout(text, comment, author="Editor"):
    page, rects = find(text)
    if not rects:
        print(f"!! not found (strikeout): {text!r}")
        return
    a = page.add_strikeout_annot(rects)
    a.set_info(content=comment, title=author)
    a.update()
    print(f"strikeout  p{page.number+1}: {text!r}")


def sticky(text, comment, author="Editor"):
    page, rects = find(text)
    if not rects:
        print(f"!! not found (sticky): {text!r}")
        return
    pt = fitz.Point(rects[0].x1 + 4, rects[0].y0)
    a = page.add_text_annot(pt, comment)
    a.set_info(content=comment, title=author)
    a.update()
    print(f"sticky     p{page.number+1}: near {text!r}")


# Highlight a phrase the editor liked.
highlight("relationships at the center of the model", "Strong framing — keep this.")
# Strikeout content to delete.
strikeout("richer metagraph structures", "Delete: too advanced for an intro.")
# Sticky-note comment anchored near a phrase.
sticky("Alice knows Bob", "Add a small diagram illustrating this edge.")
# Another highlight with a rewrite request.
highlight("confidence score or a provenance record", "Reword: 'trust or lineage'.")
# Strikeout a redundant summary clause.
strikeout("entities are stable and reusable", "Cut — repeats the intro.")

doc.save(dst)
print(f"saved {dst}")
