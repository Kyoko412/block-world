/* 制作端原录音清单。游戏只带导出的 WAV，不带这些缓存或 Strudel。 */
const kenney = (file, sha256) => ({
  file: file + '.ogg', cache: 'kenney', sha256, author: 'Kenney', authorPage: 'https://kenney.nl',
  source: 'https://kenney.nl/assets/impact-sounds', note: 'Impact Sounds，CC0 拟音原录音'
});
const wareya = (file, sha256) => ({
  file, sha256, author: 'Wareya', authorPage: 'https://warsong.pages.dev/',
  source: 'https://warsong.pages.dev/tags/sounds/', download: 'https://warsong.pages.dev/sounds/rpg%20foley.zip',
  note: 'RPG Foley，作者明确说明为真实环境录制的拟音'
});
const freesound = (author, id, preview, file, sha256, extra = {}) => ({
  file, sha256, author, authorPage: `https://freesound.org/people/${author}/`,
  source: `https://freesound.org/people/${author}/sounds/${id}/`, download: preview,
  note: '作者公开的 HQ MP3 试听版本，同一 CC0 真实录音；不是原始 WAV/FLAC', ...extra
});
export const SOURCES = {
  punch0: kenney('impactPunch_medium_000', '486988aa2d6440ffc4c62a0e8ccf3c23673ba84424bd4723378d451b7255eb5c'),
  punch1: kenney('impactPunch_medium_001', 'e71d23abcc3f10d9d6bc9615b2a431fff70b12333a5fcdd9964457564ace4349'),
  punch2: kenney('impactPunch_medium_002', '6492f9ccbc8d24dcef607bb1b48790b7870961474561f7fe5601e1c73a3018ef'),
  soft0: kenney('impactSoft_medium_000', '7d3ba0bb5e60a11b5d3e558c141303dcf494256675fbf753c0d252d2cf0481e3'),
  soft2: kenney('impactSoft_medium_002', '5069e3571a77d7f7aae9ef71d0364aa245fb7d64a7c8cc9956f221d03088c089'),
  soft4: kenney('impactSoft_medium_004', 'b0a4dea90eed47accf50b768beff1166f2f1486fb139e4d025b2427637624bca'),
  metal0: kenney('impactMetal_light_000', '33b5e6e37c6e9d54e07bf5a89b12c76e879f40c1ea83cdd82714df1d6f9fec6d'),
  metal3: kenney('impactMetal_light_003', '92d5db6bfc672d9dc1b4f390b2900504f013187fa36335472554fafefa9050b1'),
  plate4: kenney('impactPlate_light_004', '9cb33b0c0cce948313f078b60769d2f8e4075472494fc8f8129aa4a23c951897'),
  wood1: kenney('impactWood_medium_001', '15271dbe8e2872dbb0ff1aeb7b12b2d2b92b7c1951c88532b9ab9158c36dfc73'),
  wood4: kenney('impactWood_medium_004', '7ba48f2f99c91c71be420841a91f1e69c0cbc4fe887fcd7213144d67bb87b13a'),
  woodHeavy1: kenney('impactWood_heavy_001', 'f1b07a53ac10c615fff9ba470511fdeb722b5902e1a8520759fc20ad6f546015'),
  woodHeavy3: kenney('impactWood_heavy_003', 'af07511902b309b3f6d8f0e1fafbe93869127fb88099ebdc0aa6a00a98dc3cb0'),
  plank2: kenney('impactPlank_medium_002', 'f6a14da45994229676b4f29e6a35f504b5c2ec2b8166fb1a3b1aa004bc6911ef'),
  plank4: kenney('impactPlank_medium_004', '6a51318c1c63821ea757622b57fafbf44c16c28129f6d39406a784260d87c447'),
  swish: wareya('foley - swishes.wav', '74ffa578473e8f52754439ccf5c1c1dba74ecae2d628d34c6078f66123140b35'),
  cloth: wareya('foley - clothes.wav', '15769059a992d22f895ef69e71f38d536e9249d22b55e40b434d8a20899afca6'),
  clank: wareya('foley - metal clank.wav', '1bdf918477228579a54961c091179d932de88fed473589315b6b5e28d451234a'),
  chain: wareya('foley - chain a.wav', '4c565d2c27cd49b5ec31489be6d84d84a99e99ad9a6504a6bda6b541ed3f97f8'),
  voice: freesound('unfa', 610991, 'https://cdn.freesound.org/previews/610/610991_1038806-hq.mp3', 'grunts-610991-hq.mp3', 'fc63160db51a6812e80b54be1b517f5f4b944fc59acac5b626fed54f8eeb395f'),
  bow0: freesound('Ali_6868', 384915, 'https://cdn.freesound.org/previews/384/384915_984733-hq.mp3', 'bow-384915-hq.mp3', 'ece6c098cb7a03438b494a3f3e2bdd8b629fe26555d5b39f1933d78731b13fbf'),
  bow1: freesound('Ali_6868', 384916, 'https://cdn.freesound.org/previews/384/384916_984733-hq.mp3', 'bow-384916-hq.mp3', 'd31e818cf3cc24c5fd33270d3508372df703243c7bb49c333018c2bb82842ab4'),
  arrow0: freesound('Ali_6868', 384914, 'https://cdn.freesound.org/previews/384/384914_984733-hq.mp3', 'arrow-384914-hq.mp3', '3f74c56420b1ee0d21f14eb60647ae45d4b49a4a24d3731c60220cff979ea300'),
  arrow1: freesound('Ali_6868', 384913, 'https://cdn.freesound.org/previews/384/384913_984733-hq.mp3', 'arrow-384913-hq.mp3', 'a20ff9de84ba5da4540b4b6762cb244afe2214925629ca7a3852690b97db8ed2'),
  water: freesound('felix.blume', 384218, 'https://cdn.freesound.org/previews/384/384218_1661766-hq.mp3', 'underwater-384218-first256k.mp3', 'c1b4844606b066de8b5d2f28e733381ec01f75bd58c0595f157067aeba7f77cf', {
    byteLimit: 262144, note: '水听器真实水下录音；取公开 HQ MP3 前 262144 字节（约 10.68 秒），使用其中两段气泡'
  })
};
