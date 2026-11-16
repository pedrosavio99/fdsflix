' Abas no topo no estilo do site: texto cinza, aba atual com sublinhado vermelho, aba com foco em pílula vermelha.
sub init()
  m.items = m.top.findNode("items")
  m.focusIdx = 0
  m.parts = []
  m.top.observeField("focusedChild", "refresh")
end sub

sub build()
  while m.items.getChildCount() > 0
    m.items.removeChildIndex(0)
  end while
  m.parts = []
  font = makeFont("pkg:/fonts/Inter-Bold.ttf", 22)
  x = 0
  for each name in m.top.tabs
    w = Len(name) * 13 + 44
    pill = CreateObject("roSGNode", "Poster")
    pill.uri = "pkg:/images/pill_red.9.png"
    pill.translation = [x, 0]
    pill.width = w
    pill.height = 44
    pill.visible = false
    label = CreateObject("roSGNode", "Label")
    label.translation = [x, 0]
    label.width = w
    label.height = 44
    label.horizAlign = "center"
    label.vertAlign = "center"
    label.font = font
    label.text = name
    bar = CreateObject("roSGNode", "Rectangle")
    bar.translation = [x + 20, 46]
    bar.width = w - 40
    bar.height = 3
    bar.color = "0xE50914FF"
    bar.visible = false
    m.items.appendChild(pill)
    m.items.appendChild(bar)
    m.items.appendChild(label)
    m.parts.push({ pill: pill, label: label, bar: bar })
    x = x + w + 6
  end for
  m.focusIdx = m.top.selected
  refresh()
end sub

sub onSelected()
  m.focusIdx = m.top.selected
  refresh()
end sub

sub refresh()
  focused = m.top.isInFocusChain()
  for i = 0 to m.parts.count() - 1
    p = m.parts[i]
    isFocus = (focused and i = m.focusIdx)
    isSel = (i = m.top.selected)
    p.pill.visible = isFocus
    p.bar.visible = (isSel and not isFocus)
    if isFocus or isSel
      p.label.color = "0xFFFFFFFF"
    else
      p.label.color = "0xA9A9BDFF"
    end if
  end for
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if not press then return false
  n = m.parts.count()
  if key = "left" and m.focusIdx > 0
    m.focusIdx = m.focusIdx - 1
    refresh()
    return true
  else if key = "right" and m.focusIdx < n - 1
    m.focusIdx = m.focusIdx + 1
    refresh()
    return true
  else if key = "OK"
    m.top.selected = m.focusIdx
    m.top.activated = m.focusIdx
    return true
  end if
  return false
end function
