"""Read ConStory train/valid with isolated pyarrow; avoid shadowing stdlib select."""
import hashlib
import json
from collections import Counter
from pathlib import Path
import random
import re
import sys
import pyarrow.parquet as pq

ROOT = Path(__file__).resolve().parent.parent
SOURCE = Path(r'D:\AI\Story Dome\Dataset\ConStory-Bench\Dataset')
SEED = 20261029

def save(name, value):
    target = ROOT / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

tables = {}
for split in ['train', 'valid']:
    file = SOURCE / split / 'prompts.parquet'
    table = pq.read_table(file)
    rows = table.to_pylist()
    tables[split] = (file, rows)
    print(json.dumps({'split': split, 'schema': str(table.schema), 'rows': len(rows), 'languages': dict(Counter(str(r.get('language')) for r in rows)), 'tasks': dict(Counter(str(r.get('task_type')) for r in rows)), 'first': {k: str(v)[:140] for k,v in rows[0].items()}}, ensure_ascii=False))

if '--select' in sys.argv:
    audit = []
    chosen = {}
    for split, (file, rows) in tables.items():
        count = 2 if split == 'train' else 3
        groups = sorted({r['task_type'] for r in rows})
        selected = []
        for task in groups:
            candidates = [(i, r) for i, r in enumerate(rows) if r['task_type'] == task]
            random.Random(f'{SEED}:{split}:{task}').shuffle(candidates)
            found = 0
            for i, row in candidates:
                reason = None
                prompt = row['prompt']
                if row['language'] != 'en':
                    reason = 'language is not en'
                elif re.search(r'\b(?:a |one )?single[- ]scene\b|\bonly one scene\b|\bword\s+scene\b', prompt, re.I):
                    reason = 'explicit single-scene request'
                else:
                    lengths = [int(n.replace(',', '')) for n in re.findall(r'\b(\d[\d,]*)\s*(?:words?|word[- ]long)\b', prompt, re.I)]
                    if lengths and max(lengths) < 1500:
                        reason = 'explicit total word limit below 1500'
                audit.append({'split': split, 'task_type': task, 'rowIndex0': i, 'id': row['id'], 'eligible': reason is None, 'reason': reason or 'English; no explicit single-scene or sub-1500 total requirement detected; selected prompt manually checked before delivery'})
                if reason:
                    continue
                selected.append({'record': {k: row[k] for k in ['id','language','task_type','prompt']}, 'source': {'file': str(file), 'sha256': hashlib.sha256(file.read_bytes()).hexdigest(), 'rowIndex0': i, 'rowNumber1': i+1, 'id': row['id']}})
                found += 1
                if found == count:
                    break
            if found != count:
                raise RuntimeError(f'Insufficient eligible {split}/{task}: {found}/{count}')
        chosen[split] = selected
    save('build/selected-records.json', chosen)
    save('labels/selection-audit.json', {'seed': SEED, 'algorithm': 'Python Random string seed, independent shuffle within task and split; first qualifying rows', 'decisions': audit, 'pyarrowVersion': __import__('pyarrow').__version__})
    print('Selected', {k: len(v) for k,v in chosen.items()})
