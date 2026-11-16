sub init()
  m.top.findNode("name").font = makeFont("pkg:/fonts/Inter-Bold.ttf", 18)
end sub

sub onContent()
  c = m.top.itemContent
  if c = invalid then return
  m.top.findNode("logo").uri = c.HDPosterUrl
  m.top.findNode("name").text = c.title
  ' cor de fundo do cartão vem da API como "#rrggbb" (os logos são feitos para fundo claro)
  hex = c.ShortDescriptionLine2
  if Len(hex) = 7 and Left(hex, 1) = "#"
    m.top.findNode("card").color = "0x" + UCase(Mid(hex, 2)) + "FF"
  end if
end sub
