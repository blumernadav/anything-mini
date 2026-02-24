const fs = require('fs');

const old = JSON.parse(fs.readFileSync('./data/OLD_ANYTHING_to_migrate.json', 'utf8'));
const items = JSON.parse(fs.readFileSync('./data/items.json', 'utf8'));

// Find kolwrite in old data
const oldKolwrite = old.activities.find(a => a.name === 'kolwrite');
if (!oldKolwrite) { console.log('No kolwrite in old data'); process.exit(1); }

// Find kolwrite in new data
const newKolwrite = items.items.find(a => a.name === 'kolwrite');
if (!newKolwrite) { console.log('No kolwrite in items.json'); process.exit(1); }

// Find max id in current items.json
let maxId = 0;
function findMaxId(item) {
    if (item.id && item.id > maxId) maxId = item.id;
    if (item.children) item.children.forEach(findMaxId);
}
items.items.forEach(findMaxId);
console.log('Current max ID in items.json:', maxId);

// Convert old format to new format
let nextId = maxId + 1;
function convertItem(oldItem) {
    const newItem = {
        id: nextId++,
        name: oldItem.name,
        children: (oldItem.children || []).map(convertItem),
        expanded: false,
        createdAt: oldItem.createdAt || Date.now(),
        done: !!oldItem.done,
        timeContexts: ['ongoing']
    };
    return newItem;
}

const convertedChildren = oldKolwrite.children.map(convertItem);
console.log('Converted', convertedChildren.length, 'kolwrite children');
console.log('New ID range:', maxId + 1, 'to', nextId - 1);

// Append them to the kolwrite node in items.json
newKolwrite.children.push(...convertedChildren);
console.log('New total kolwrite children:', newKolwrite.children.length);

// Write back
fs.writeFileSync('./data/items.json', JSON.stringify(items, null, 2));
console.log('Done! items.json updated.');
