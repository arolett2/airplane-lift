import './ui/styles/tokens.css';
import './ui/styles/main.css';
import './ui/styles/components.css';
import './ui/styles/panels.css';
import './ui/styles/viz.css';
import './ui/styles/lesson.css';
import { startApp } from './app/App';

const root = document.getElementById('app');
if (root) {
  startApp(root).catch((error: unknown) => {
    console.error(error);
    root.textContent = 'The wind tunnel failed to start. See the console for details.';
  });
}
