import test from 'node:test';
import assert from 'node:assert/strict';
import { dualInstruction } from '../src/aiRecognitionV2.js';

test('the review asks AI to add missed inputs and drop fixed text', () => {
  assert.equal(dualInstruction.includes('Never guess missing positions'), false);
  assert.equal(dualInstruction.includes('missed by the scanner must be added'), true);
  assert.equal(dualInstruction.includes('recognized=false and targets=[]'), true);
  assert.equal(dualInstruction.includes('Empty paragraphs are inputs only when'), true);
});
