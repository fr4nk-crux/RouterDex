# RouterDex

![RouterDex Screenshot](screenshot.png)

Catalogue interactif des modèles IA disponibles sur [OpenRouter](https://openrouter.ai).

## Fonctionnalités

- 📊 **Leaderboard** — Top modèles par utilisation (mise à jour hebdomadaire)
- 🔍 **Recherche & filtres** — Par provider, catégorie, prix
- 📋 **Comparaison** — Jusqu'à 4 modèles côte à côte
- 💾 **Export JSON** — Exporter les données des modèles

## Catégories

- Text, Multimodal, Image, Audio
- Modèles gratuits, Reasoning, Code

## Installation

### Depuis les releases
Télécharger le `.exe` (Windows) (https://github.com/fr4nk-crux/RouterDex/releases/tag/RouterDex).

### Build
Nécessite [Rust](https://rustup.rs/).
```bash
npm run tauri build
```
Linux - Mac

https://github.com/fr4nk-crux/RouterDex/blob/main/.github/workflows/build.yml

### Développement
```bash
npm install
npm run dev
```


## Données

- Modèles : [OpenRouter API](https://openrouter.ai/api/v1/models)
- Leaderboard : Mise à jour hebdomadaire depuis [routerdex-data](https://github.com/fr4nk-crux/RouterDex/blob/main/public/data/leaderboard.json)

## Licence

MIT