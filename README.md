# ResearchLens AI

ResearchLens AI is a private, browser-based research workspace for exploring papers. Import PDFs, find relevant passages with page-level citations, create extractive summaries, and compare themes across your collection—all stored locally in your browser.

## Live dashboard

[Open ResearchLens AI](https://aditya-kusale.github.io/ResearchLens-AI-Research-Workspace/)

## What works

- Import multiple text-based PDFs by file picker or drag and drop.
- Extract text page by page in the browser with PDF.js.
- Keep extracted text and the original PDFs in browser IndexedDB so the collection survives a refresh on that device.
- Split pages into overlapping passages and rank them for questions with a local TF-IDF retrieval index.
- Open a source citation in the PDF reader at its cited page.
- Create extractive paper summaries from sentences in the source.
- Compare shared vocabulary, paper-specific emphasis, and possible coverage gaps across papers.
- Remove papers and their local data from the collection.

## Run locally

Serve this directory over HTTP, then open it in a modern browser. PDF.js is loaded as a pinned ES module from jsDelivr, so an internet connection is needed on first load. For example:

```sh
python -m http.server 8000
```

Then visit `http://localhost:8000`.

## Privacy and current limits

PDF contents and the search index stay in the browser's IndexedDB; they are not uploaded to a server. This static MVP does not use a language model or external vector database. Search uses TF-IDF lexical ranking, summaries select source sentences, and collection comparisons are vocabulary-based signals. Treat retrieved passages as evidence to review, and verify potential gaps against the papers themselves. Scanned PDFs without selectable text need OCR, which is not included.

## Next steps toward the full platform

1. Add an opt-in embedding model and semantic vector search.
2. Add a secured API for grounded answer synthesis and citation verification.
3. Add OCR for scanned papers and richer citation/reference extraction.
4. Add accounts and encrypted synchronization for collections across devices.

## License

ResearchLens AI is available under the [MIT License](LICENSE).
