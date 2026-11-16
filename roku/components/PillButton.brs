' Botão em pílula (vermelho com foco, escuro sem foco), igual aos botões do site.
sub init()
  m.bg = m.top.findNode("bg")
  m.label = m.top.findNode("label")
  m.label.font = makeFont("pkg:/fonts/Inter-Bold.ttf", 22)
  m.top.observeField("focusedChild", "refresh")
  layout()
end sub

sub layout()
  m.bg.width = m.top.width
  m.label.width = m.top.width
  m.label.text = m.top.text
  refresh()
end sub

sub refresh()
  if m.top.isInFocusChain()
    m.bg.uri = "pkg:/images/pill_red.9.png"
    m.label.color = "0xFFFFFFFF"
  else
    m.bg.uri = "pkg:/images/pill_dark.9.png"
    m.label.color = "0xF2F2F7FF"
  end if
end sub

function onKeyEvent(key as string, press as boolean) as boolean
  if press and key = "OK"
    m.top.selected = true
    return true
  end if
  return false
end function
