import { libraryTools } from './library';
import { visionTools } from './vision';
import { webTools } from './web';
import { imageTools } from './image';
import { Tool } from '../types';

export const allTools: Tool[] = [
  ...libraryTools,
  ...visionTools,
  ...webTools,
  ...imageTools
];
