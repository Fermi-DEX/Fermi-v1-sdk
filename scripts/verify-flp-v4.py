#!/usr/bin/env python3
"""Check the packaged wire interface against the pinned PUBLIC Rust snapshot.
Usage: python3 scripts/verify-flp-v4.py /path/to/fermi-v1-programs
This intentionally supports only the concrete Anchor syntax in this release.
Unknown syntax fails closed. It is not a general Anchor IDL generator.
"""
import hashlib
import json
from pathlib import Path
import re
import subprocess
import sys

PIN = '623f113075bd124948eabac8589bfbe8c53b11e8'
root = Path(sys.argv[1]).resolve()
assert subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() == PIN
assert not subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain'], text=True).strip(), 'Source checkout must be clean'
src = root / 'flp/programs/flp-vault/src'
sdk_root = Path(__file__).resolve().parents[1]
idl_path = sdk_root / 'src/flp/idl/flp_vault_v4.json'
if not idl_path.exists():
    idl_path = sdk_root / 'dist/flp/idl/flp_vault_v4.json'
assert hashlib.sha256(idl_path.read_bytes()).hexdigest() == '022363b3b6b18160c90fc10dc56f8dc2eb3416669ccdf2f5d2021db90e0cf7b7', 'Pinned IDL byte hash mismatch'
idl = json.loads(idl_path.read_text())
texts = {str(p.relative_to(src)): p.read_text() for p in sorted(src.rglob('*.rs'))}
source = '\n'.join(texts.values())

def camel(s):
    parts = s.split('_')
    return parts[0] + ''.join(p[:1].upper() + p[1:] for p in parts[1:])

def body(text, start, opening='{', closing='}'):
    depth = 1
    for i in range(start, len(text)):
        if text[i] == opening: depth += 1
        elif text[i] == closing: depth -= 1
        if depth == 0: return text[start:i]
    raise AssertionError('Unbalanced source')

structs = {}
for m in re.finditer(r'pub struct (\w+)(?:<[^>]+>)?\s*\{', source):
    structs[m[1]] = body(source, m.end())

def fields(name):
    text = structs[name]
    last = 0
    out = []
    for m in re.finditer(r'pub (\w+):\s*([^\n]+)', text):
        ty = m[2].strip().removesuffix(',')
        attrs = text[last:m.start()]
        out.append((m[1], ty, attrs))
        last = m.end()
    return out

def accounts(name):
    out = []
    for field, ty, attrs in fields(name):
        nested = re.fullmatch(r"(\w+)<'info>", ty)
        if nested and nested[1] in structs:
            out.append({'name': camel(field), 'accounts': accounts(nested[1])})
        else:
            writable = bool(re.search(r'\b(mut|init|init_if_needed)\b', attrs))
            signer = "Signer<'info>" in ty or bool(re.search(r'\bsigner\b', attrs))
            if re.search(r'\binit\b', attrs) and 'seeds' not in attrs:
                signer = True
            leaf = {'name': camel(field), 'isMut': writable, 'isSigner': signer}
            if ty.startswith('Option<'): leaf['isOptional'] = True
            out.append(leaf)
    return out

constants = dict(re.findall(r'pub const (\w+): usize = (\d+);', source))
def datatype(ty):
    if ty == 'Pubkey': return 'publicKey'
    if ty in ['bool', 'u8', 'u16', 'u32', 'u64', 'u128', 'i8', 'i16', 'i32', 'i64', 'i128']: return ty
    array = re.fullmatch(r'\[(.+);\s*(\w+)\]', ty)
    if array: return {'array': [datatype(array[1]), int(constants.get(array[2], array[2]))]}
    assert ty in structs or re.search(r'pub enum ' + ty + r'\b', source), ty
    return {'defined': ty}

program = texts['lib.rs'].split('pub mod flp_vault {', 1)[1]
functions = []
for m in re.finditer(r'pub fn (\w+)(?:<[^>]+>)?\s*\(', program):
    signature = body(program, m.end(), '(', ')')
    ctx = re.search(r'Context<(.*?)>(?:,|$)', signature, re.S)
    assert ctx, m[1]
    context = re.findall(r'\b([A-Z]\w*)', ctx[1])[-1]
    args = re.findall(r'(\w+):\s*(\w+)', signature[ctx.end():])
    functions.append({'name': camel(m[1]), 'accounts': accounts(context),
                      'args': [{'name': camel(n), 'type': datatype(t)} for n, t in args]})

def strip_docs(obj):
    if isinstance(obj, dict): return {k: strip_docs(v) for k, v in obj.items() if k != 'docs'}
    if isinstance(obj, list): return [strip_docs(v) for v in obj]
    return obj

assert len(functions) == len(idl['instructions']), 'Instruction count mismatch'
for actual, expected in zip(functions, idl['instructions']):
    assert actual == strip_docs(expected), (actual, strip_docs(expected))
for item in idl['accounts'] + idl['types']:
    if item['type']['kind'] == 'struct':
        expected = [{'name': camel(n), 'type': datatype(t)} for n, t, _ in fields(item['name'])]
        assert expected == strip_docs(item['type']['fields']), item['name']
    else:
        match = re.search(r'pub enum ' + item['name'] + r'\s*\{', source)
        variants = [x.strip().split('=')[0].strip() for x in body(source, match.end()).split(',') if x.strip()]
        assert [{'name': n} for n in variants] == item['type']['variants'], item['name']
for item in idl['events']:
    expected = [{'name': camel(n), 'type': datatype(t), 'index': False} for n, t, _ in fields(item['name'])]
    assert expected == strip_docs(item['fields']), item['name']
errors = re.findall(r'#\[msg\("([^"]+)"\)\]\s*(\w+)', texts['error.rs'])
assert [{'code': 6000 + i, 'name': n, 'msg': msg} for i, (msg, n) in enumerate(errors)] == idl['errors']
evidence = json.loads((root / 'flp/build-evidence.json').read_text())
assert evidence['program'] == 'FLPRrDPN5tJpLx6wY6FUiGFN5Kws8gHUCYMCcs6Goa9Q'
assert idl['metadata']['address'] == evidence['program']
assert evidence['deployedBytesEqual'] is True
assert evidence['elfSha256'] == '4cd0f7787be53a52195ff21bc34797f3eb40de1810d17443d883f1533f59f36e'
assert f'declare_id!("{evidence["program"]}")' in texts['lib.rs']
print(f'PASS: {len(functions)} instructions, {len(idl["accounts"])} accounts, {len(idl["types"])} types, {len(idl["events"])} events, {len(errors)} errors match {PIN}')
print('IDL SHA-256:', hashlib.sha256(idl_path.read_bytes()).hexdigest())
print('Build evidence checked; no live chain or remote-verifier assertion made.')

# Preserve the existing r9 wire interface. Anchor JSON account names differ only
# in initial capitalization; the canonical account discriminators are unchanged.
sdk_core = json.loads((idl_path.parents[2] / 'idl/fermi_v1.json').read_text())
public_core = json.loads((root / 'mango_v4.json').read_text())
for section in ['instructions', 'types', 'events', 'errors']:
    assert strip_docs(sdk_core[section]) == strip_docs(public_core[section]), 'Core ' + section
for side in [sdk_core, public_core]:
    for account in side['accounts']:
        account['name'] = account['name'][0].upper() + account['name'][1:]
assert strip_docs(sdk_core['accounts']) == strip_docs(public_core['accounts']), 'Core accounts'
print('PASS: existing r9 core IDL wire interface matches public snapshot (account-name capitalization normalized).')
