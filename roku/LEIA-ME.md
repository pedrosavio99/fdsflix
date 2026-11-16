# fdsFlix para Roku

Cliente fino da API do fdsFlix (BrightScript/SceneGraph). Não renderiza o site: o Roku não tem WebView.
Quem monta o zip é o servidor (`GET /api/admin/devices/roku.zip`, botão **Aparelhos** do admin), já com o endereço dele em `config.json`.

- `source/main.brs` — entrada; lê `config.json` e guarda `apiBase`/`apiKey` no nó global.
- `components/MainScene.*` — menu, fileiras, busca, TV ao vivo, player e "Outra versão" (tecla `*`).
- `components/DetailScreen.*` — detalhes, temporadas e episódios.
- `components/ApiTask.*` / `api.brs` — chamadas HTTP (`roUrlTransfer` numa Task) e auxiliares.
- `images/` — ícones, splash, logo e o 9-patch de foco (cores e logo do site).

Validar (sem Roku): `bsc --rootDir roku --files "manifest" "source/**/*" "components/**/*" "config.json" --createPackage false --copyToStaging false`
(pacote `brighterscript`). Instalar na TV: veja o manual no admin (Aparelhos).

## Rodar de verdade (emulador, sem Roku)

O `bsc` só confere sintaxe. Para executar o app (SceneGraph, Tasks, foco, teclas) use o emulador `brs-node` — precisa de **Node 22**:

```bash
npm i brs-node                       # numa pasta de trabalho, fora do projeto
npx -p node@22 node node_modules/brs-node/bin/brs.cli.js --root <pasta-com-roku-e-config.json-local> -g debug -e -l run.log
curl -X POST http://127.0.0.1:8060/keypress/Down      # ECP: Up/Down/Left/Right/Select/Back/Play/Lit_a ...
```

`-s arquivo.png` + Ctrl+S (via pseudo-terminal) salva um print da tela renderizada. Achou com isso: foco perdido pelo `scene.setFocus`,
`Dialog.message` com tipo errado, `config.json` ignorado. Coloque `print` temporário numa CÓPIA, não no app.
