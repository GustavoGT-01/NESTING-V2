// Simulação: G-code -> movimentos e remoção de material. Rodar: node tests/sim_check.js
const assert = require('assert');
const { _parse: parse, _Stock: Stock, _Sim: Sim } = require('../sim.js');
const tools = [{ num: 1, name: 'Fresa 6', dia: 6 }];
const g = 'G90 G21\nG0 Z15\nT1 M06\nS18000 M03\nG0 X50 Y50\nG0 Z2\nG1 Z-15.2 F600\nG1 X150 F6000\nG0 Z15\nG0 X100 Y80 Z-5\n';
const plan = parse([{ gcode: g }], tools, { th: 15, zero: 'topo', rapid: 12000, sheetW: 300, sheetH: 200 });
assert.ok(plan.total > 0 && plan.moves.length >= 6);
const cut = plan.moves.find(m => !m.rapid && m.x1 === 150);
assert.strictEqual(cut.tool.dia, 6);
assert.ok(Math.abs(cut.t1 - cut.t0 - 1) < 1e-6);                 // 100 mm a 6000 mm/min = 1 s
const stock = new Stock(300, 200, 15, 0.2), sim = new Sim(plan, stock);
assert.strictEqual(stock.at(100, 50), 15);
sim.seek(plan.total);
assert.ok(stock.at(100, 50) < 0);                                 // atravessou até a mesa
assert.strictEqual(stock.at(100, 60), 15);                        // fora do raio: intacto
assert.strictEqual(sim.hits.length, 1);                           // G0 descendo dentro do material = colisão
sim.seek(0);
assert.strictEqual(stock.at(100, 50), 15);                        // voltar no tempo refaz a chapa
console.log('sim_check ok');
