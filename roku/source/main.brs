' fdsFlix para Roku: cliente fino da API do servidor. Toda a lógica (fontes, legendas, troca de versão)
' fica no servidor; este app só mostra as listas e toca a URL que o servidor devolve.
sub Main()
  screen = CreateObject("roSGScreen")
  port = CreateObject("roMessagePort")
  screen.SetMessagePort(port)

  cfg = LoadConfig()
  globalNode = screen.getGlobalNode()
  globalNode.addFields({ apiBase: cfg.api, apiKey: cfg.key })

  scene = screen.CreateScene("MainScene")
  screen.Show()
  scene.setFocus(true)

  while true
    msg = wait(0, port)
    if type(msg) = "roSGScreenEvent"
      if msg.isScreenClosed() then return
    end if
  end while
end sub

function LoadConfig() as object
  cfg = { api: "https://fdsflix.onrender.com", key: "" }
  raw = ReadAsciiFile("pkg:/config.json")
  if raw <> invalid and raw <> ""
    parsed = ParseJson(raw)
    if type(parsed) = "roAssociativeArray"
      if type(parsed.api) = "roString" and parsed.api <> "" then cfg.api = parsed.api
      if type(parsed.key) = "roString" then cfg.key = parsed.key
    end if
  end if
  while Right(cfg.api, 1) = "/"
    cfg.api = Left(cfg.api, Len(cfg.api) - 1)
  end while
  return cfg
end function
