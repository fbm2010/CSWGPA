"""Extract PDF element text with the locally installed Unstructured package."""

import io
import json
import os
import sys


def _configure_offline_tokenizer():
    """Prevent Unstructured from downloading a spaCy model at parse time."""
    import spacy
    from unstructured.nlp import tokenize

    nlp = spacy.blank("en")
    nlp.add_pipe("sentencizer")
    tokenize._get_nlp = lambda: nlp


def _partition(pdf_bytes, source_text):
    strategy = os.environ.get("UNSTRUCTURED_STRATEGY", "fast")

    try:
        # Preferred path when all optional Unstructured PDF dependencies exist.
        from unstructured.partition.pdf import partition_pdf

        return partition_pdf(file=io.BytesIO(pdf_bytes), strategy=strategy)
    except (ImportError, ModuleNotFoundError):
        # Some installations omit native image-layout libraries (for example
        # libGL). Keep processing fully local: pdfminer extracts the text and
        # Unstructured still partitions it into typed document elements.
        from unstructured.partition.text import partition_text

        _configure_offline_tokenizer()
        return partition_text(text=source_text)


def main():
    pdf_bytes = sys.stdin.buffer.read()
    if not pdf_bytes:
        raise ValueError("No PDF data received")

    # Retain source-order text alongside Unstructured's elements. PDF element
    # ordering can be lossy on multi-column Schoology reports, so the caller
    # can choose the parse that recovered the complete schedule.
    from pdfminer.high_level import extract_text
    from pdfminer.layout import LAParams

    # Schoology exports use positioned columns. Different PDF producers need
    # different pdfminer flow settings, so retain several local reading-order
    # interpretations and let the record parser select the most complete one.
    source_texts = []
    for boxes_flow in (0.5, None, -1.0, 1.0):
        text = extract_text(
            io.BytesIO(pdf_bytes),
            laparams=LAParams(boxes_flow=boxes_flow),
        )
        if text and text not in source_texts:
            source_texts.append(text)

    source_text = source_texts[0] if source_texts else ""
    elements = _partition(pdf_bytes, source_text)
    json.dump(
        {
            "text": "\n".join(str(element) for element in elements),
            "sourceTexts": source_texts,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
