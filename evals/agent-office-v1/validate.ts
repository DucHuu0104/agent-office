import { agentOfficeV1Corpus, validateAgentOfficeV1Corpus } from './corpus';

const errors = validateAgentOfficeV1Corpus();
if (errors.length) {
  console.error(`Agent Office v1 eval corpus is invalid:\n- ${errors.join('\n- ')}`);
  process.exitCode = 1;
} else {
  const counts = agentOfficeV1Corpus.reduce<Record<string, number>>((result, task) => {
    result[task.category] = (result[task.category] ?? 0) + 1;
    return result;
  }, {});
  console.log(`Valid Agent Office v1 corpus: ${agentOfficeV1Corpus.length} tasks; ${Object.entries(counts).map(([name, count]) => `${name}=${count}`).join(', ')}. No model calls made.`);
}
