sub init()
  m.kb = m.top.findNode("kb")
  m.grid = m.top.findNode("grid")
  m.msg = m.top.findNode("msg")
  m.spinner = m.top.findNode("spinner")
  m.timer = m.top.findNode("debounce")
  m.top.findNode("head").font = makeFont("pkg:/fonts/Inter-Black.ttf", 36)
  m.msg.font = makeFont("pkg:/fonts/Inter-Regular.ttf", 22)
  m.top.findNode("hint").font = makeFont("pkg:/fonts/Inter-Regular.ttf", 18)
  m.token = 0
  m.area = "kb"
  m.kb.observeField("text", "onText")
  m.timer.observeField("fire", "doSearch")
  m.grid.observeField("itemSelected", "onPick")
end sub

sub reset()
  m.kb.text = ""
  m.grid.content = invalid
  m.grid.visible = false
  m.msg.text = "Digite o nome de um filme ou série."
  m.msg.visible = true
  m.area = "kb"
  m.kb.setFocus(true)
end sub

sub onText()
  m.timer.control = "stop"
  if Len(m.kb.text) >= 2
    m.timer.control = "start"
  else
    m.grid.visible = false
    m.msg.text = "Digite o nome de um filme ou série."
    m.msg.visible = true
  end if
end sub

sub doSearch()
  text = m.kb.text
  if Len(text) < 2 then return
  m.token = m.token + 1
  m.msg.visible = false
  m.spinner.visible = true
  m.spinner.control = "start"
  apiGet("/api/search?q=" + urlEnc(text), "onResults", m.token.toStr() + "|" + text)
end sub

sub onResults(event as object)
  res = event.getData()
  if res = invalid then return
  sep = Instr(1, res.tag, "|")
  if sep < 1 or Left(res.tag, sep - 1) <> m.token.toStr() then return
  m.spinner.control = "stop"
  m.spinner.visible = false
  root = CreateObject("roSGNode", "ContentNode")
  if res.ok and res.data <> invalid and res.data.results <> invalid
    for each it in res.data.results
      if it.poster <> invalid and it.poster <> ""
        year = ""
        if it.year <> invalid then year = it.year
        ov = ""
        if it.overview <> invalid then ov = it.overview
        node = makeItem(it.type, it.id, it.title, posterUrl(it.poster, "w185"), posterUrl(it.poster, "w342"), "", year, ov, it.rating, "")
        root.appendChild(node)
      end if
    end for
  else
    m.msg.text = failText("Não foi possível buscar agora.", res)
    m.msg.visible = true
    return
  end if
  if root.getChildCount() = 0
    m.grid.visible = false
    m.msg.text = "Nada encontrado para " + Mid(res.tag, sep + 1) + "."
    m.msg.visible = true
    return
  end if
  m.grid.content = root
  m.grid.visible = true
end sub

sub onPick()
  idx = m.grid.itemSelected
  if idx < 0 or m.grid.content = invalid then return
  node = m.grid.content.getChild(idx)
  colon = Instr(1, node.id, ":")
  m.top.picked = { type: Left(node.id, colon - 1), id: Mid(node.id, colon + 1), title: node.title, year: node.ReleaseDate, overview: node.Description, backdrop: node.HDBackgroundImageUrl, meta: node.ReleaseDate }
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  if key = "back"
    if m.area = "grid"
      m.kb.setFocus(true)
      m.area = "kb"
    else
      m.top.closed = true
    end if
    return true
  else if key = "play" or key = "fastforward"
    if m.area = "kb" and m.grid.visible
      m.grid.setFocus(true)
      m.area = "grid"
    else
      m.kb.setFocus(true)
      m.area = "kb"
    end if
    return true
  else if key = "right" and m.area = "kb" and m.grid.visible
    m.grid.setFocus(true)
    m.area = "grid"
    return true
  else if key = "left" and m.area = "grid"
    m.kb.setFocus(true)
    m.area = "kb"
    return true
  end if
  return false
end function
