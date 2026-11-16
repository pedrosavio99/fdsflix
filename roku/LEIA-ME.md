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
