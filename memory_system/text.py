"""Tokenization and token accounting.

Two consumers:

* the FTS5 lexical index, which needs a token stream for both documents and
  queries (FTS5 itself is only a storage/index format here — the ``unicode61``
  tokenizer splits on whitespace and punctuation and would make every Chinese
  sentence a single token, so we feed it pre-segmented terms);
* the L4 attention budget, which must be able to *estimate* tokens locally
  without calling a model tokenizer.

The default segmenter is dependency-free:

* Han ideographs are emitted as **overlapping bigrams** plus unigrams. For a
  language without word delimiters, bigrams are the standard cheap substitute
  for segmentation and keep recall high at the cost of index size.
* Everything else is lowercased and split on non-alphanumerics.

``jieba`` is used when available and requested, which improves precision.
"""

from __future__ import annotations

import re
import unicodedata
from functools import lru_cache

_HAN_RANGES = (
    (0x3400, 0x4DBF),
    (0x4E00, 0x9FFF),
    (0xF900, 0xFAFF),
    (0x20000, 0x2FA1F),
)
_WORD_RE = re.compile(r"[a-z0-9_]+")
_LATIN_OR_HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]|[a-z0-9_]+")

STOPWORDS = frozenset(
    """a an the and or but if then else of to in on at by for with from as is are was were be been
    being it its this that these those i you he she they we me my your our their what which who whom
    how when where why not no yes do does did done can could should would will shall may might must
    about into over under again more most other some such only own same so than too very just
    """.split()
)


def is_han(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _HAN_RANGES)


def _normalize(text: str) -> str:
    # NFKC folds full-width Latin/digits and CJK compatibility ideographs.
    return unicodedata.normalize("NFKC", text).lower()


@lru_cache(maxsize=1)
def _jieba_available() -> bool:
    try:
        import jieba  # noqa: F401

        return True
    except Exception:  # pragma: no cover - environment dependent
        return False


@lru_cache(maxsize=1)
def _jieba():
    import jieba

    jieba.setLogLevel(60)  # silence the "building prefix dict" banner
    return jieba


def _split_latin_and_han(text: str) -> list[str]:
    """Split into maximal runs: ``[("han", "记忆系统"), ("latin", "dsh"), ...]``."""
    out: list[tuple[str, str]] = []
    buf: list[str] = []
    kind: str | None = None
    for ch in _normalize(text):
        k = "han" if is_han(ch) else ("latin" if ch.isalnum() or ch == "_" else None)
        if k is None:
            if buf and kind:
                out.append((kind, "".join(buf)))
            buf, kind = [], None
            continue
        if kind is not None and k != kind:
            out.append((kind, "".join(buf)))
            buf = []
        kind = k
        buf.append(ch)
    if buf and kind:
        out.append((kind, "".join(buf)))
    return out


def _han_bigrams(run: str) -> list[str]:
    if len(run) == 1:
        return [run]
    grams = [run[i : i + 2] for i in range(len(run) - 1)]
    # Unigrams matter for rare single characters used as terms.
    grams.extend(run)
    return grams


def prewarm(tokenizer: str = "auto") -> bool:
    """Load the CJK tokenizer now instead of on the first query.

    Importing jieba and building its prefix dictionary costs ~400 ms, which
    would otherwise land on the first recall of a session — the one call a
    user actually waits for. Returns True if a real segmenter is available.
    """
    if tokenizer != "jieba" and not _jieba_available():
        return False
    try:
        jieba = _jieba()
        # jieba.cut returns a LAZY generator: the prefix-dictionary build (and
        # its ~280 ms) happens during iteration, not when cut() is called.
        # Building a short but realistic CJK sequence forces that work here,
        # where the host can afford it, instead of inside the first recall.
        list(jieba.cut("预热分词器构建前缀词典并验证加载完成", HMM=False))
        _split_latin_and_han("预热分词器构建前缀词典并验证加载完成")
    except Exception:  # pragma: no cover - environment dependent
        return False
    return True


def tokenize(text: str, *, tokenizer: str = "auto", max_term_len: int = 24) -> list[str]:
    """Return the index/query term stream for ``text``.

    Order is preserved and duplicates kept: FTS5 uses positions, so repeated
    terms carry phrase-proximity information.

    Single Han characters are dropped when the segmenter produces them: a
    one-character term such as 的 / 了 / 是 appears in almost every Chinese
    sentence, so indexing it matches everything and defeats the BM25 ranking.
    The bigram path never emits a lone character for a multi-character run, so
    this only prunes noise, not recall.
    """
    if not text:
        return []
    use_jieba = tokenizer == "jieba" or (tokenizer == "auto" and _jieba_available())
    pieces = _split_latin_and_han(text)
    terms: list[str] = []
    for kind, run in pieces:
        if kind == "latin":
            terms.append(run)
            continue
        if use_jieba:
            for word in _jieba().cut(run, HMM=False):
                word = word.strip()
                if not word or all(not (is_han(c) or c.isalnum()) for c in word):
                    continue
                # A 1-char Chinese term is a function word or a stray particle
                # more often than a real term; a multi-char run's bigrams cover
                # the case where it matters.
                if len(word) == 1 and is_han(word):
                    continue
                terms.append(word)
        else:
            terms.extend(_han_bigrams(run))
    return [t for t in terms if t not in STOPWORDS and len(t) <= max_term_len]


def keywords(text: str, limit: int = 12, *, tokenizer: str = "auto") -> list[str]:
    """Rank terms by frequency and length; used for anchors, intent labels, cross-links."""
    counts: dict[str, float] = {}
    for term in tokenize(text, tokenizer=tokenizer):
        # A CJK bigram is far more informative than a unigram.
        counts[term] = counts.get(term, 0.0) + (1.6 if len(term) >= 2 else 1.0)
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], -len(kv[0]), kv[0]))
    out: list[str] = []
    for term, _ in ranked:
        # Drop a bigram's unigrams once the bigram is kept, then collapse
        # bigrams to segments: 记忆, 忆系, 系统 -> 记忆系统
        out.append(term)
        if len(out) >= limit * 3:
            break
    collapsed = _collapse_bigrams(out)
    return collapsed[:limit]


def _collapse_bigrams(terms: list[str]) -> list[str]:
    """Merge overlapping pairs of 2-char CJK terms into longer segments.

    ``[记忆, 忆系, 系统]`` -> ``[记忆系统]``. Terms that are not all-CJK are
    passed through untouched. Order follows first appearance.
    """
    out: list[str] = []
    used: set[int] = set()
    for i, term in enumerate(terms):
        if i in used:
            continue
        if len(term) == 2 and all(is_han(c) for c in term):
            chain = term
            j = i + 1
            while j < len(terms):
                nxt = terms[j]
                if len(nxt) == 2 and all(is_han(c) for c in nxt) and nxt[0] == chain[-1]:
                    chain += nxt[1]
                    used.add(j)
                    j += 1
                else:
                    break
            out.append(chain)
        else:
            out.append(term)
    return out


def estimate_tokens(text: str | None) -> int:
    """Cheap local token estimate used to enforce attention budgets.

    Chosen to be *conservative* (over-estimate) rather than precise: for
    CJK text one token per character is a good upper bound for most
    tokenizers; for Latin text ~4 characters per token. Punctuation and
    whitespace get a small per-character allowance.
    """
    if not text:
        return 0
    han = sum(1 for c in text if is_han(c))
    rest = len(text) - han
    return int(han + rest / 3.5) + 1


def clip_words(text: str, limit: int) -> str:
    """Truncate to at most ``limit`` visible characters at a grapheme-ish boundary."""
    text = (text or "").strip()
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)].rstrip() + "…"


def normalize_name(name: str) -> str:
    """Entity/reference normal form: NFKC, lower, collapse separators."""
    name = _normalize(name or "").strip()
    name = re.sub(r"[\s_]+", " ", name)
    return name


def phrase_terms(text: str, *, tokenizer: str = "auto") -> list[str]:
    """Distinct terms for building an FTS5 MATCH expression."""
    seen: dict[str, None] = {}
    for t in tokenize(text, tokenizer=tokenizer):
        seen.setdefault(t, None)
    return list(seen)


def fts_match_expression(text: str, *, tokenizer: str = "auto") -> str | None:
    """Build a safe FTS5 MATCH query (OR of quoted terms).

    Terms are double-quoted so FTS5 never interprets operators embedded in
    user or model text; internal quotes are doubled per FTS5 syntax.
    """
    terms = phrase_terms(text, tokenizer=tokenizer)
    if not terms:
        return None
    quoted = ['"' + t.replace('"', '""') + '"' for t in terms]
    return " OR ".join(quoted)


def fts_index_text(text: str, *, tokenizer: str = "auto") -> str:
    """The body to store in an FTS5 column that is searched with :func:`tokenize`.

    The tables use ``tokenize='unicode61'``, which splits on non-alphanumerics:
    a Chinese sentence becomes **one** token and can never be matched by a
    multi-character query. Storing the pre-segmented term stream (the same
    stream ``fts_match_expression`` builds queries from) makes the index and
    the queries speak the same vocabulary, and leaves Latin text intact because
    ``tokenize`` already lowercases and splits it.
    """
    return " ".join(tokenize(text, tokenizer=tokenizer))