let pdfjsLib;
try {
  pdfjsLib = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.mjs');
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.mjs';
} catch (error) {
  console.error('Could not load the PDF reader library.', error);
}

const DB_NAME = 'researchlens-local';
const DB_VERSION = 1;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const CHUNK_WORDS = 170;
const STOP_WORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other ought our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves also may might must shall shoulds using use used useds').split(/\s+/));

const $ = (selector) => document.querySelector(selector);
const elements = {
  fileInput: $('#fileInput'), paperList: $('#paperList'), paperCount: $('#paperCount'),
  dropzone: $('#dropzone'), toast: $('#toast'), askForm: $('#askForm'), question: $('#question'),
  answer: $('#answer'), insightGrid: $('#insightGrid'), indexStatus: $('#indexStatus'),
  compareBtn: $('#compareBtn'), refreshInsights: $('#refreshInsights'), readerDialog: $('#readerDialog'),
  readerCanvas: $('#readerCanvas'), readerTitle: $('#readerTitle'), readerPageLabel: $('#readerPageLabel'),
};

let db;
let papers = [];
let currentPdf = null;
let currentPage = 1;
let toastTimer;

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle('error', isError);
  elements.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove('show'), 3600);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('papers', { keyPath: 'id' });
      store.createIndex('uploadedAt', 'uploadedAt');
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact(mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('papers', mode);
    const request = action(transaction.objectStore('papers'));
    if (request) {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    } else {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    }
  });
}

const savePaper = (paper) => transact('readwrite', (store) => store.put(paper));
const deletePaper = (id) => transact('readwrite', (store) => store.delete(id));
const loadPapers = () => transact('readonly', (store) => store.getAll());

function splitIntoPassages(text, pageNumber) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  const passages = [];
  for (let start = 0; start < words.length; start += CHUNK_WORDS - 28) {
    const passage = words.slice(start, start + CHUNK_WORDS).join(' ').trim();
    if (passage.length > 45) passages.push({ page: pageNumber, text: passage });
  }
  return passages;
}

async function extractPdf(file, onProgress) {
  const buffer = await file.arrayBuffer();
  if (!pdfjsLib) throw new Error('The PDF reader library did not load. Reload the page with an internet connection and try again.');
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)), isEvalSupported: false }).promise;
  const pages = [];
  const passages = [];
  let title = file.name.replace(/\.pdf$/i, '');
  try {
    const metadata = await pdf.getMetadata();
    if (metadata?.info?.Title?.trim()) title = metadata.info.Title.trim();
  } catch { /* Some PDFs do not expose metadata. */ }

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const text = content.items.map((item) => item.str || '').join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ number: pageNumber, text });
    passages.push(...splitIntoPassages(text, pageNumber));
    onProgress(pageNumber, pdf.numPages);
  }
  if (!passages.length) throw new Error('No selectable text was found. This may be a scanned PDF; OCR is not included yet.');

  return {
    id: crypto.randomUUID(), name: file.name, title, size: file.size,
    pageCount: pdf.numPages, uploadedAt: new Date().toISOString(), pages, passages,
    fileBuffer: buffer,
  };
}

function words(text) {
  return (text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) || []).filter((word) => !STOP_WORDS.has(word) && word.length > 2);
}

function termCounts(text) {
  const counts = new Map();
  for (const word of words(text)) counts.set(word, (counts.get(word) || 0) + 1);
  return counts;
}

function buildIndex() {
  const docs = papers.flatMap((paper) => paper.passages.map((passage, index) => ({ ...passage, paperId: paper.id, paperTitle: paper.title, paperName: paper.name, passageId: `${paper.id}:${index}` })));
  const df = new Map();
  const countsByPassage = docs.map((doc) => termCounts(doc.text));
  countsByPassage.forEach((counts) => counts.forEach((_, term) => df.set(term, (df.get(term) || 0) + 1)));
  const averageLength = docs.length ? docs.reduce((sum, doc) => sum + words(doc.text).length, 0) / docs.length : 1;
  return { docs, df, countsByPassage, averageLength };
}

function searchIndex(query, index, limit = 5) {
  const queryTerms = [...new Set(words(query))];
  if (!queryTerms.length || !index.docs.length) return [];
  const n = index.docs.length;
  const ranked = index.docs.map((doc, position) => {
    const counts = index.countsByPassage[position];
    const length = [...counts.values()].reduce((sum, count) => sum + count, 0) || 1;
    let score = 0;
    queryTerms.forEach((term) => {
      const frequency = counts.get(term) || 0;
      if (!frequency) return;
      const inverseFrequency = Math.log(1 + (n - (index.df.get(term) || 0) + 0.5) / ((index.df.get(term) || 0) + 0.5));
      score += inverseFrequency * (frequency * 2.2) / (frequency + 1.2 * (0.25 + 0.75 * length / index.averageLength));
    });
    return { ...doc, score };
  });
  return ranked.filter((doc) => doc.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
}

function summarize(paper, maxSentences = 4) {
  const source = paper.pages.map((page) => page.text).join(' ');
  const sentences = source.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [];
  if (!sentences.length) return 'No extractable text was found.';
  const docCounts = termCounts(source);
  const scored = sentences.map((sentence, position) => {
    const sentenceWords = words(sentence);
    const score = sentenceWords.reduce((sum, word) => sum + Math.log1p(docCounts.get(word) || 0), 0) / Math.max(1, Math.sqrt(sentenceWords.length));
    return { sentence: sentence.trim(), position, score };
  }).filter((item) => item.sentence.length > 35);
  return scored.sort((a, b) => b.score - a.score).slice(0, maxSentences).sort((a, b) => a.position - b.position).map((item) => item.sentence).join(' ');
}

function topicScores(paper) {
  const counts = termCounts(paper.pages.map((page) => page.text).join(' '));
  const max = Math.max(1, ...counts.values());
  return new Map([...counts].map(([term, count]) => [term, count / max]));
}

function getCollectionAnalysis() {
  if (!papers.length) return { themes: [], distinct: [], gaps: [] };
  const scores = papers.map(topicScores);
  const union = new Set(scores.flatMap((map) => [...map.keys()]));
  const rows = [...union].map((term) => {
    const perPaper = scores.map((map) => map.get(term) || 0);
    const coverage = perPaper.filter((value) => value > 0.06).length;
    const mean = perPaper.reduce((sum, value) => sum + value, 0) / scores.length;
    return { term, coverage, mean, perPaper };
  });
  const themes = rows.filter((row) => row.coverage >= Math.min(2, papers.length) && row.term.length > 3).sort((a, b) => b.coverage - a.coverage || b.mean - a.mean).slice(0, 8);
  const distinct = rows.filter((row) => row.coverage === 1).sort((a, b) => b.mean - a.mean).slice(0, 8);
  const gaps = papers.length > 1 ? papers.map((paper, index) => {
    const absent = rows.filter((row) => row.perPaper[index] < 0.04 && row.perPaper.some((score, other) => other !== index && score > 0.16)).sort((a, b) => b.mean - a.mean).slice(0, 4);
    return { paper, absent };
  }).filter((item) => item.absent.length) : [];
  return { themes, distinct, gaps };
}

function renderPapers() {
  elements.paperCount.textContent = papers.length;
  if (!papers.length) {
    elements.paperList.innerHTML = '<div class="empty-state">Your uploaded papers will appear here.</div>';
    return;
  }
  elements.paperList.innerHTML = papers.map((paper) => `
    <article class="paper" data-paper-id="${escapeHtml(paper.id)}">
      <span class="file-type">PDF</span>
      <div class="paper-copy"><strong title="${escapeHtml(paper.title)}">${escapeHtml(paper.title)}</strong><small>${paper.pageCount} pages · ${paper.passages.length} passages · ${Math.max(1, Math.round(paper.size / 1024))} KB</small></div>
      <button class="paper-action summary-action" data-action="summary" title="Show extractive summary" aria-label="Summarize ${escapeHtml(paper.title)}">▤</button>
      <button class="paper-action remove-action" data-action="remove" title="Remove paper" aria-label="Remove ${escapeHtml(paper.title)}">×</button>
    </article>`).join('');
  elements.paperList.querySelectorAll('[data-action="summary"]').forEach((button) => button.addEventListener('click', () => showSummary(button.closest('.paper').dataset.paperId)));
  elements.paperList.querySelectorAll('[data-action="remove"]').forEach((button) => button.addEventListener('click', () => removePaper(button.closest('.paper').dataset.paperId)));
}

function renderStats() {
  const passages = papers.reduce((sum, paper) => sum + paper.passages.length, 0);
  const pages = papers.reduce((sum, paper) => sum + paper.pageCount, 0);
  const analysis = getCollectionAnalysis();
  $('#statPapers').textContent = papers.length;
  $('#statPages').textContent = pages;
  $('#statPassages').textContent = passages;
  $('#statTopics').textContent = analysis.themes.length;
  $('#collectionMeta').textContent = `${papers.length} ${papers.length === 1 ? 'paper' : 'papers'} · ${pages} ${pages === 1 ? 'page' : 'pages'} extracted · stored in this browser`;
  elements.compareBtn.disabled = papers.length < 2;
  elements.refreshInsights.disabled = papers.length < 2;
  elements.indexStatus.classList.toggle('ready', papers.length > 0);
  elements.indexStatus.innerHTML = papers.length ? `<i></i> ${passages} passages searchable` : '<i></i> Waiting for papers';
  renderInsights(analysis);
}

function renderInsights(analysis = getCollectionAnalysis()) {
  if (papers.length < 2) {
    elements.insightGrid.innerHTML = '<article class="insight-placeholder"><span class="insight-icon">✦</span><h3>Collection insights appear here</h3><p>Add at least two papers to compare recurring vocabulary and topics that appear in one paper but are not prominent in the others.</p></article>';
    return;
  }
  const terms = (items) => items.length ? items.map((item) => `<span class="topic-chip">${escapeHtml(item.term)}</span>`).join('') : '<span class="muted">Not enough shared signal yet.</span>';
  const gapMarkup = analysis.gaps.length ? analysis.gaps.slice(0, 2).map(({ paper, absent }) => `<div class="gap-row"><strong>${escapeHtml(paper.title)}</strong><p>Topics emphasized elsewhere but less visible here: ${absent.map((item) => `<span class="topic-chip small">${escapeHtml(item.term)}</span>`).join(' ')}</p></div>`).join('') : '<p class="muted">No distinct topic coverage differences surfaced.</p>';
  elements.insightGrid.innerHTML = `
    <article><span class="insight-icon">↗</span><p class="eyebrow">SHARED THEMES</p><h3>Vocabulary across the collection</h3><div class="topic-list">${terms(analysis.themes)}</div><p class="insight-foot">Terms occur across more than one paper. This is a lexical signal, not a claim of conceptual agreement.</p></article>
    <article><span class="insight-icon amber">◉</span><p class="eyebrow">DISTINCT EMPHASIS</p><h3>Topics concentrated in one paper</h3><div class="topic-list">${terms(analysis.distinct)}</div><p class="insight-foot">Use these as starting points for a closer comparison.</p></article>
    <article><span class="insight-icon violet">⌁</span><p class="eyebrow">POTENTIAL COVERAGE GAPS</p><h3>Under-covered vocabulary</h3>${gapMarkup}<p class="insight-foot">Automated vocabulary comparison only; review the source papers before treating these as research gaps.</p></article>`;
}

function renderAnswer(query, results) {
  if (!results.length) {
    elements.answer.innerHTML = `<p class="answer-label">NO MATCHING PASSAGES</p><h3>I couldn’t find a passage matching “${escapeHtml(query)}”.</h3><p>Try using terms that appear in the papers, or check whether the PDF contains selectable text.</p>`;
    return;
  }
  elements.answer.innerHTML = `<p class="answer-label">RETRIEVED EVIDENCE · ${results.length} SOURCE ${results.length === 1 ? 'PASSAGE' : 'PASSAGES'}</p><h3>Here are the closest passages I found for “${escapeHtml(query)}”.</h3><p>Read the cited passages together to form an answer. ResearchLens ranks evidence locally and does not generate claims beyond the source text.</p><div class="sources">${results.map((result, index) => `<article class="source-card"><p>${escapeHtml(result.text)}</p><div class="source-meta"><button class="citation" data-paper-id="${escapeHtml(result.paperId)}" data-page="${result.page}">[${index + 1}] ${escapeHtml(result.paperTitle)} · p. ${result.page}</button> <span>relevance ${Math.round(Math.min(1, result.score / Math.max(0.1, results[0].score)) * 100)}%</span></div></article>`).join('')}</div>`;
  elements.answer.querySelectorAll('.citation').forEach((button) => button.addEventListener('click', () => openReader(button.dataset.paperId, Number(button.dataset.page))));
}

function showSummary(paperId) {
  const paper = papers.find((item) => item.id === paperId);
  if (!paper) return;
  const summary = summarize(paper);
  elements.answer.innerHTML = `<p class="answer-label">EXTRACTIVE SUMMARY · ${escapeHtml(paper.title)}</p><h3>Key sentences selected from the paper text</h3><p>${escapeHtml(summary)}</p><div class="source-meta"><button class="citation" data-paper-id="${escapeHtml(paper.id)}" data-page="1">Open source PDF · p. 1</button></div>`;
  elements.answer.querySelector('.citation').addEventListener('click', () => openReader(paper.id, 1));
  elements.answer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showAnalysis() {
  const analysis = getCollectionAnalysis();
  renderInsights(analysis);
  showToast('Collection comparison refreshed from extracted paper text.');
}

async function addFiles(fileList) {
  const files = [...fileList].filter((file) => file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf'));
  if (!files.length) return showToast('Choose PDF files to add.', true);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      showToast(`${file.name} exceeds the 25 MB per-file limit.`, true);
      continue;
    }
    if (!file.size) continue;
    const progressToast = (page, total) => {
      elements.toast.textContent = `Indexing ${file.name} · page ${page} of ${total}`;
      elements.toast.classList.add('show');
    };
    progressToast(0, '…');
    try {
      const paper = await extractPdf(file, progressToast);
      await savePaper(paper);
      papers.push(paper);
      papers.sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
      renderPapers();
      renderStats();
      showToast(`Indexed ${paper.pageCount} pages from ${paper.title}.`);
    } catch (error) {
      console.error(error);
      showToast(`${file.name}: ${error.message || 'Could not read this PDF.'}`, true);
    }
  }
  elements.fileInput.value = '';
}

async function removePaper(paperId) {
  const paper = papers.find((item) => item.id === paperId);
  if (!paper) return;
  await deletePaper(paperId);
  papers = papers.filter((item) => item.id !== paperId);
  renderPapers();
  renderStats();
  elements.answer.innerHTML = '<p class="answer-label">PAPER REMOVED</p><h3>Your local index has been updated.</h3><p>Removed paper text and its saved PDF from this browser.</p>';
  showToast(`Removed ${paper.title} from this browser.`);
}

function askQuestion(query) {
  const index = buildIndex();
  const results = searchIndex(query, index);
  renderAnswer(query, results);
}

async function openReader(paperId, pageNumber = 1) {
  const paper = papers.find((item) => item.id === paperId);
  if (!paper) return showToast('This paper is no longer in the collection.', true);
  try {
    if (!pdfjsLib) throw new Error('The PDF reader library did not load. Reload the page with an internet connection and try again.');
    currentPdf = await pdfjsLib.getDocument({ data: new Uint8Array(paper.fileBuffer.slice(0)), isEvalSupported: false }).promise;
    currentPage = Math.max(1, Math.min(pageNumber, currentPdf.numPages));
    elements.readerTitle.textContent = paper.title;
    await renderReaderPage();
    elements.readerDialog.showModal();
  } catch (error) {
    showToast(`Could not open this PDF: ${error.message}`, true);
  }
}

async function renderReaderPage() {
  if (!currentPdf) return;
  const page = await currentPdf.getPage(currentPage);
  const viewport = page.getViewport({ scale: 1.25 });
  const canvas = elements.readerCanvas;
  const context = canvas.getContext('2d');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  elements.readerPageLabel.textContent = `Page ${currentPage} of ${currentPdf.numPages}`;
  await page.render({ canvasContext: context, viewport }).promise;
}

elements.fileInput.addEventListener('change', (event) => addFiles(event.target.files));
elements.dropzone.addEventListener('click', () => elements.fileInput.click());
elements.dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); elements.fileInput.click(); }
});
for (const type of ['dragenter', 'dragover']) elements.dropzone.addEventListener(type, (event) => { event.preventDefault(); elements.dropzone.classList.add('dragover'); });
for (const type of ['dragleave', 'drop']) elements.dropzone.addEventListener(type, (event) => { event.preventDefault(); elements.dropzone.classList.remove('dragover'); });
elements.dropzone.addEventListener('drop', (event) => addFiles(event.dataTransfer.files));
elements.askForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = elements.question.value.trim();
  if (!query) return;
  if (!papers.length) return showToast('Add a text-based PDF before asking a question.', true);
  askQuestion(query);
  elements.question.value = '';
});
elements.compareBtn.addEventListener('click', showAnalysis);
elements.refreshInsights.addEventListener('click', showAnalysis);
$('#prevPage').addEventListener('click', async () => { if (currentPdf && currentPage > 1) { currentPage -= 1; await renderReaderPage(); } });
$('#nextPage').addEventListener('click', async () => { if (currentPdf && currentPage < currentPdf.numPages) { currentPage += 1; await renderReaderPage(); } });
$('#closeReader').addEventListener('click', () => elements.readerDialog.close());
elements.readerDialog.addEventListener('click', (event) => { if (event.target === elements.readerDialog) elements.readerDialog.close(); });

try {
  db = await openDatabase();
  papers = (await loadPapers()).sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt));
  renderPapers();
  renderStats();
  if (!pdfjsLib) showToast('PDF tools did not load. Reload the page with an internet connection to add papers.', true);
} catch (error) {
  console.error(error);
  showToast('Local storage is unavailable. Try opening the dashboard in a standard browser window.', true);
}
