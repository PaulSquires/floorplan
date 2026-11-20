// tiko and FreeBASIC: #import modules (directories), #include files, #inclib libraries, ' and /' '/
// comments, and the procedures and types a file offers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { lib, makeProject, run } from './helpers.mjs';

const { extract } = await lib('extract.mjs');
const { classify } = await lib('common.mjs');

const scanOf = (files) => {
  const root = makeProject(files);
  try {
    run('scan.mjs', root);
    return JSON.parse(fs.readFileSync(path.join(root, 'floorplan', '.cache', 'scan.json'), 'utf8'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
};
const linksOf = (scan) => scan.edges.map((e) => `${e.from} -> ${e.to}`).sort();

test('tiko: files are code in the tiko language', () => {
  for (const f of ['main.tiko', 'api.ti', 'old.bas', 'old.bi', 'frmMain.inc']) assert.deepEqual(classify(f, 100), { category: 'code', lang: 'tiko' }, f);
});

test('tiko: imports, includes, libraries, symbols and docs; comments and strings are not code', () => {
  const r = extract([
    "'' orders.tiko -- Takes orders and works out what they cost.",
    "''",
    "'' More detail that is not the summary.",
    '#module "orders"',
    '#import "std/strings" as txt',
    '#Import "../billing" public',
    '#include once "helpers\\money.ti"',
    '#inclib "sqlite3"',
    "' #import \"commented/out\"",
    "/' #include \"block.ti\"",
    "   /' nested '/ #include \"still-comment.ti\" '/",
    'rem #include "rem.ti"',
    'const MSG = "it\'s #import ""quoted"""',
    'const API = "https://api.stripe.com/v1/charges"',
    'const HOME = "http://localhost:8080/"',
    'const T1 = "http://a/b" : const T2 = "http://[fe80::1]/" : const T3 = "https://user:pw@db.example.org/"',
    '',
    "'' One order line.",
    'public type OrderLine',
    '    qty as long',
    '    declare function Total( ) as double',
    'end type',
    'public type Money as double',
    'type Internal',
    'end type',
    '',
    "'' Adds up an order.",
    'public function OrderTotal( byval n as long ) as double',
    '    function = n',
    'end function',
    'function OrderLine.Total( ) as double',
    'end function',
    'sub Helper( )',
    'end sub',
    'declare sub Later( )',
    'public enum Status',
    '    Open',
    'end enum',
  ].join('\n'), 'tiko', 'app/orders/orders.tiko');
  assert.deepEqual(r.imports.map((i) => `${i.kind} ${i.spec}`), ['module std/strings', 'module ../billing', 'include helpers/money.ti', 'lib sqlite3', 'module-self .']);
  assert.equal(r.imports[0].alias, 'txt');
  assert.equal(r.imports[1].reexport, true);
  assert.equal(r.module, 'orders');
  // in a module only public names reach importers; methods, declarations and alias targets are left out
  assert.deepEqual(r.symbols.map((s) => `${s.kind} ${s.name}`), ['type OrderLine', 'type Money', 'function OrderTotal', 'enum Status']);
  assert.equal(r.symbols[0].doc, 'One order line.');
  assert.equal(r.symbols[2].doc, 'Adds up an order.');
  assert.equal(r.doc, 'Takes orders and works out what they cost.');
  assert.deepEqual(r.hosts.map((h) => h.host), ['api.stripe.com']);
});

test('tiko: outside a module every name not marked private is visible', () => {
  const r = extract(['/\' util.bi: small helpers for strings. \'/', '#pragma once', 'function Trim2( ) as string', 'end function', 'private sub Hidden( )', 'end sub'].join('\n'), 'tiko', 'util.bi');
  assert.deepEqual(r.symbols.map((s) => s.name), ['Trim2']);
  assert.equal(r.doc, 'small helpers for strings.');
});

test('tiko toolchain itself: std/ imports link to its pkg/std modules when they are in the mapped folder', () => {
  const scan = scanOf({
    'pkg/std/strings/strings.tiko': '#module "strings"\n#import "std/containers"\n',
    'pkg/std/containers/containers.tiko': '#module "containers"\n',
  });
  assert.deepEqual(linksOf(scan), ['pkg/std/strings/strings.tiko -> pkg/std/containers/containers.tiko']);
});

test('tiko: a module with no main file is reached through the files declaring the names the importer uses', () => {
  const scan = scanOf({
    'gui/Button.tiko': '#module "gui"\npublic type CButton\nend type\n',
    'gui/ListView.tiko': '#module "gui"\npublic type CListView\nend type\n',
    'gui/Menu.tiko': '#module "gui"\npublic function MakeMenu( ) as long\nend function\n',
    'app.tiko': '#import "./gui"\ndim b as gui.cbutton\nprint gui.MakeMenu( )\n',
  });
  assert.deepEqual(linksOf(scan), ['app.tiko -> gui/Button.tiko', 'app.tiko -> gui/Menu.tiko']);
});

test('tiko: a licence paragraph at the top is passed over for the one that describes the file', () => {
  const r = extract([
    "'    Copyright (C) 2026 Someone",
    "'    This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.",
    "'",
    "' tkApp -- the application framework: start-up, the loop and tear-down.",
    "' More words.",
    '#module "tkApp"',
  ].join('\n'), 'tiko', 'tkApp/tkApp.tiko');
  assert.equal(r.doc, 'the application framework: start-up, the loop and tear-down.');
});

test('tiko project: module imports link to the main file of the module, which links to the rest, includes to files, toolchain packages are outside', () => {
  const scan = scanOf({
    'units/tiko.toml': '[package]\nname = "units"\n',
    'units/length/length.tiko': '#module "length"\npublic function Metres( ) as double\nend function\n',
    'app/tiko.toml': '[package]\nname = "app"\n\n[dependencies]\nunits = { path = "../units" }\nwordkit = { path = "../../elsewhere/wordkit" }\n',
    'app/main.tiko': [
      '#import "./textstats"',
      '#import "app/report"',
      '#import "units/length"',
      '#import "wordkit/count"',
      '#import "std/fs"',
      '#import "vendor/sqlite3"',
      '#include once "inc\\Config.ti"',
      '#include "windows.bi"',
      '#include once "AfxNova/AfxWin.inc"',
      '#inclib "user32"',
      'print 1',
    ].join('\n'),
    'app/textstats/textstats.tiko': '#module "textstats"\n#include "../inc/config.ti"\n',
    'app/textstats/words.tiko': '#module "textstats"\n',
    'app/textstats/notes.ti': "'' a header beside the module\n",
    'app/report/report.tiko': '#module "report"\n',
    'app/inc/config.ti': 'const DEBUG = 1\n',
  });
  assert.deepEqual(linksOf(scan), [
    'app/main.tiko -> app/inc/config.ti',
    'app/main.tiko -> app/report/report.tiko',
    'app/main.tiko -> app/textstats/textstats.tiko',
    'app/main.tiko -> units/length/length.tiko',
    'app/textstats/textstats.tiko -> app/inc/config.ti',
    'app/textstats/textstats.tiko -> app/textstats/words.tiko',
  ]);
  assert.deepEqual(scan.externals.map((e) => e.id).sort(), ['lib:user32', 'tiko:AfxNova', 'tiko:std/fs', 'tiko:vendor/sqlite3', 'tiko:wordkit']);
});
