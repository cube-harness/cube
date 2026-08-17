import { PIIDetector } from '@mastra/core/processors';

export default new PIIDetector({
  model: 'openai/gpt-4o',
  strategy: 'block',
});