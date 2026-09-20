# Contador de Graos V4

## Novidade: referencia metrica permanente
Use um quadrado de cor distinta, por exemplo azul, no mesmo plano dos graos. Informe o lado real em mm (padrao 50 mm), clique em CALIBRAR COR DO QUADRADO e depois clique no quadrado na imagem. A aplicacao busca continuamente um componente dessa cor, valida formato aproximadamente quadrado e atualiza a escala px/mm.

A referencia e excluida da mascara de graos. Medidas reais exibidas: area media em mm2 e diametro equivalente em mm.

## Publicar no GitHub Pages
1. Crie repositorio novo.
2. Envie o conteudo desta pasta, incluindo src e .github.
3. Settings > Pages > Source: GitHub Actions.
4. Commit em main e aguarde build/deploy verdes.

## Observacao geometrica
Um unico quadrado permanente corrige continuamente a escala local e ajuda a detectar mudancas da camera. Para correcao completa de perspectiva do plano inteiro, a proxima extensao prevista e usar quatro referencias fixas, uma em cada canto da area util, permitindo homografia do plano.
