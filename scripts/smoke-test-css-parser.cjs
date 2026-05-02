const Parser = require('web-tree-sitter');
const path = require('path');

(async () => {
  await Parser.init();
  const parser = new Parser();
  const lang = await Parser.Language.load(
    path.join(process.cwd(), 'wasm', 'tree-sitter-css.wasm')
  );
  parser.setLanguage(lang);

  const css = `
@keyframes spin { 0% { transform: rotate(0deg); } }
@media (min-width: 768px) { .x { color: red; } }
@import "foo.css";
.normal-rule { color: blue; }
`;

  const tree = parser.parse(css);

  const queryStr = `
    (rule_set (selectors) @symbol_name) @class
    (keyframes_statement (keyframes_name) @symbol_name) @class
    (media_statement (feature_query) @symbol_name) @class
    (import_statement (string_value) @symbol_name) @class
    (at_rule (at_keyword) @symbol_name) @class
  `;

  const query = lang.query(queryStr);
  const matches = query.matches(tree.rootNode);

  console.log('Total matches: ' + matches.length);
  for (const m of matches) {
    const sym = m.captures.find(c => c.name === 'symbol_name');
    const cls = m.captures.find(c => c.name === 'class');
    const symText = sym ? sym.node.text : '<missing>';
    const clsType = cls ? cls.node.type : '<missing>';
    console.log('  symbolName: "' + symText + '" class.type: ' + clsType);
  }

  if (matches.length < 4) {
    console.log('[FAIL] menos de 4 matches');
    process.exit(1);
  }
  console.log('[PASS] al menos 4 matches');
})();
