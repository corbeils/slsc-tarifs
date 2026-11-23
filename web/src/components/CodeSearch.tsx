import { useEffect, useRef, useState } from 'react';
import { api, type SearchHit } from '../api';

export default function CodeSearch({
  j,
  value,
  onSelect,
}: {
  j: 'US' | 'CA';
  value: SearchHit | null;
  onSelect: (h: SearchHit | null) => void;
}) {
  const [q, setQ] = useState(value?.display ?? '');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => setQ(value?.display ?? ''), [value?.code, j]);
  useEffect(() => {
    if (!q.trim() || q === value?.display) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .search(j, q)
        .then((h) => {
          setHits(h);
          setActive(0);
          setOpen(true);
        })
        .catch(() => setHits([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q, j]);
  useEffect(() => {
    const on = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', on);
    return () => document.removeEventListener('mousedown', on);
  }, []);

  const pick = (h: SearchHit) => {
    onSelect(h);
    setQ(h.display);
    setOpen(false);
  };

  return (
    <div className="search" ref={box}>
      <input
        className="input mono"
        placeholder={j === 'US' ? 'Code HTSUS ou mots-clés (ex. 8462.11, presse, gear box)' : 'Numéro tarifaire ou mots-clés'}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          if (value) onSelect(null);
        }}
        onFocus={() => hits.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !hits.length) return;
          if (e.key === 'ArrowDown') {
            setActive((a) => Math.min(a + 1, hits.length - 1));
            e.preventDefault();
          } else if (e.key === 'ArrowUp') {
            setActive((a) => Math.max(a - 1, 0));
            e.preventDefault();
          } else if (e.key === 'Enter') {
            pick(hits[active]);
            e.preventDefault();
          } else if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && hits.length > 0 && (
        <ul className="dropdown">
          {hits.map((h, i) => (
            <li key={h.code} className={i === active ? 'active' : ''} onMouseDown={() => pick(h)} onMouseEnter={() => setActive(i)}>
              <span className="mono code">{h.display}</span>
              <span className="desc">
                {h.description}
                {h.path && <small>{h.path}</small>}
              </span>
              <span className="rate">{h.general || (h.is_leaf ? '' : '›')}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
