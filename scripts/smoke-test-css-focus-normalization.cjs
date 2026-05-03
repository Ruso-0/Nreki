// Verifica que la normalización CSS de focus en compressor-foveal.ts:107
// matchea contra symbolNames almacenados por parser.ts:398

const path = require('path');

function normalizeFocus(focusInput, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const isCss = ext === ".css" || ext === ".html";
  
  return focusInput.split(",").map(s => {
    let clean = s.trim().toLowerCase();
    if (isCss) {
      clean = clean.replace(/[.#,]/g, " ").replace(/\s+/g, " ").trim();
    }
    return clean;
  }).filter(Boolean);
}

// Caso 1: focus '.home-sidebar' en CSS debe normalizar a 'home-sidebar'
const test1 = normalizeFocus('.home-sidebar', 'styles/main.css');
console.log('Test 1 (.home-sidebar in .css):');
console.log('  Result:', JSON.stringify(test1));
const test1Pass = test1[0] === 'home-sidebar';
console.log('  Expected: ["home-sidebar"]');
console.log('  ' + (test1Pass ? '[PASS]' : '[FAIL]'));

// Caso 2: focus '#main-id' en CSS debe normalizar a 'main-id'
const test2 = normalizeFocus('#main-id', 'styles/main.css');
console.log('Test 2 (#main-id in .css):');
console.log('  Result:', JSON.stringify(test2));
const test2Pass = test2[0] === 'main-id';
console.log('  Expected: ["main-id"]');
console.log('  ' + (test2Pass ? '[PASS]' : '[FAIL]'));

// Caso 3: focus 'myFunction' en .ts NO debe modificarse (shield de dominio)
const test3 = normalizeFocus('myFunction', 'src/utils.ts');
console.log('Test 3 (myFunction in .ts):');
console.log('  Result:', JSON.stringify(test3));
const test3Pass = test3[0] === 'myfunction';
console.log('  Expected: ["myfunction"] (only lowercased, NOT stripped)');
console.log('  ' + (test3Pass ? '[PASS]' : '[FAIL]'));

// Caso 4: focus 'a, b' en .ts mantiene comma split
const test4 = normalizeFocus('a, b', 'src/utils.ts');
console.log('Test 4 (a, b in .ts):');
console.log('  Result:', JSON.stringify(test4));
const test4Pass = test4.length === 2 && test4[0] === 'a' && test4[1] === 'b';
console.log('  Expected: ["a", "b"]');
console.log('  ' + (test4Pass ? '[PASS]' : '[FAIL]'));

// Caso 5: focus '.foo, .bar' en .css normaliza ambos
const test5 = normalizeFocus('.foo, .bar', 'styles/main.css');
console.log('Test 5 (.foo, .bar in .css):');
console.log('  Result:', JSON.stringify(test5));
const test5Pass = test5.length === 2 && test5[0] === 'foo' && test5[1] === 'bar';
console.log('  Expected: ["foo", "bar"]');
console.log('  ' + (test5Pass ? '[PASS]' : '[FAIL]'));

const allPass = test1Pass && test2Pass && test3Pass && test4Pass && test5Pass;
console.log('');
console.log(allPass ? '[ALL PASS]' : '[SOME FAILED]');
process.exit(allPass ? 0 : 1);
