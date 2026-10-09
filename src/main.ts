import './styles/app.css';
import { Store } from './core/store';
import { Shell } from './ui/shell';

const root = document.getElementById('app');
if (!root) throw new Error('Missing #app mount point.');

const store = new Store();
new Shell(root, store);
