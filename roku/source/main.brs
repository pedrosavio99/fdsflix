' fdsFlix para Roku: cliente fino da API do servidor. Toda a lógica (fontes, legendas, troca de versão)
' fica no servidor; este app só mostra as listas e toca a URL que o servidor devolve.
sub Main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)

  cfg = LoadConfig()
  globalNode = screen.getGlobalNode()
  globalNode.addFields({ apiBase: cfg.api, apiKey: cfg.key, debug: cfg.debug, configLoaded: cfg.loaded })

  scene = screen.CreateScene("MainScene")
  screen.Show()
  ' o foco inicial é dado pela própria cena (barra de abas); scene.setFocus(true) aqui TIRARIA o foco dela

  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent"
      if msg.isScreenClosed() then return
    end if
  end while
end sub

function LoadConfig() as object
  cfg = { api: "https://fdsflix-80ya.onrender.com", key: "", debug: false, loaded: false }
  raw = ReadAsciiFile("pkg:/config.json")
  if raw <> invalid and raw <> ""
    parsed = ParseJson(raw)
    if parsed <> invalid
      ' ParseJson devolve strings como "String" ou "roString" conforme o firmware: não dependa de type().
      api = parsed.api
      if api <> invalid and Len(api) > 0
        cfg.api = api
        cfg.loaded = true
      end if
      key = parsed.key
      if key <> invalid then cfg.key = key
      if parsed.debug = true then cfg.debug = true
    end if
  end if
  while Right(cfg.api, 1) = "/"
    cfg.api = Left(cfg.api, Len(cfg.api) - 1)
  end while
  return cfg
end function
