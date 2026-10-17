# Fonts for generated PDFs (modules/documents)

| File | Font | Source | Licence |
|---|---|---|---|
| NotoSans-Regular.ttf, NotoSans-Bold.ttf | Noto Sans (Latin, digits, punctuation, ·, —, ×) | github.com/notofonts/latin-greek-cyrillic | SIL Open Font License 1.1, `OFL-NotoSans.txt` |
| NotoSansBengali-Regular.ttf, NotoSansBengali-Bold.ttf | Noto Sans Bengali (Bangla text, ৳, Bangla digits) | github.com/notofonts/bengali | SIL Open Font License 1.1, `OFL-NotoSansBengali.txt` |

The PDF writer splits text into Bangla and non-Bangla runs and picks the font per run; Bangla is
shaped by fontkit (pdfkit's font engine: conjuncts, reph, pre-base vowel signs). Only the glyphs a
document uses are embedded. Unmodified copies of the hinted TTFs.
