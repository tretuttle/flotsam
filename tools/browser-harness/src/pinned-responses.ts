// SHA-256 and byte length of every fixture response, measured with curl and coreutils sha256sum
// against a running fixture server. A change here is a deliberate change to the served bytes.
export const PINNED_RESPONSES: Readonly<
  Record<string, { readonly sha256: string; readonly byteLength: number }>
> = {
  page: {
    sha256: "aa5c0ebdd6c77a2620b2ddc0b14969e67cdfdff3372f027c3c1b88a63f593e28",
    byteLength: 16056,
  },
  "fixtures-page": {
    sha256: "a11a6bc53b96785780d4a790c4a7147a4c80f982cce088ad274b9cd1ec5f3f9e",
    byteLength: 1036,
  },
  binary: {
    sha256: "878e8af9c4ac3ec78e970fd1fe096c046da27e12bf3242eb5df35f99d408853e",
    byteLength: 50000000,
  },
  chunked: {
    sha256: "d73baf818a7de5b42510548765abba545120e602b1315e346cc7dc59e8af5746",
    byteLength: 50000000,
  },
  gzip: {
    sha256: "837e1d367f8143efc60b284fae29c8280760d26e3e040e6eae17f13d0b06bf6d",
    byteLength: 20000000,
  },
  video: {
    sha256: "0c50030fbd1dd8ae8b9cb6c2743852d006e0b5dbfd5e2ea0f1b7772f139070ea",
    byteLength: 65536,
  },
  range: {
    sha256: "da897a66fcf7e375e5876395a996a2ab40a91a758f65f0c02337a67b1ac3679b",
    byteLength: 65536,
  },
  "range@1000-1999": {
    sha256: "89b3082a6a59b267084f2060e7873f04f332a42b6795f9cfb135dd8fe619ca6f",
    byteLength: 1000,
  },
  "post-json": {
    sha256: "1d8774442e014f7cf3638a163c919cd66ec5fe9e21bab2ae98449535af94a54f",
    byteLength: 62,
  },
  "no-store": {
    sha256: "deb177fb5a09a63562a879ad598b791cf415730184a45451de19407cd9f1e19d",
    byteLength: 38,
  },
  "r-css-0": {
    sha256: "84b2c8d8354318d68937e761dd459c4095e40ba6f133618288b2e24244868a55",
    byteLength: 20,
  },
  "r-css-1": {
    sha256: "7fa390e0294c587c05ad2c2dc420ffb4ae94652a559f99d97406f2789f6f01e9",
    byteLength: 20,
  },
  "r-css-2": {
    sha256: "e4e2b46c14560c7eb39389c787556f3b084632e2e4df66fc201b6d63c083226a",
    byteLength: 20,
  },
  "r-css-3": {
    sha256: "0306a750b44d4dff372a3d386e8b8f0f498560303ca1fc481972514476528b49",
    byteLength: 20,
  },
  "r-css-4": {
    sha256: "88276b8f545297c8ac4f0468a9499d7fc1c57e0e46ab02dff700d26981ac26f9",
    byteLength: 20,
  },
  "r-css-5": {
    sha256: "b73d3477cb586c9c8148c427a9d3893ca137debea90a00cb4b3817e549dca913",
    byteLength: 20,
  },
  "r-css-6": {
    sha256: "241a6409131d8209d77f6cd083b4d3315b66b659a4f4234790b6abb8d856e496",
    byteLength: 20,
  },
  "r-css-7": {
    sha256: "822ce1cace3370bc6927ac770cb2f9ff2ccde6d9c088d7ac37457d2f3251a28f",
    byteLength: 20,
  },
  "r-css-8": {
    sha256: "e0b44512f522f21cf52fc0d8fbaf5412e87c12519e8d7142c6f233a61ef34bfd",
    byteLength: 20,
  },
  "r-css-9": {
    sha256: "0becb54b0a503af26b55e700e5bc5139fb7a72dd533194ef5f80db608c6bf6c3",
    byteLength: 20,
  },
  "r-css-10": {
    sha256: "54d429cf55e3ed22029c5fe9fcc753ec2c8562a8b7cc818e931ff0b354584810",
    byteLength: 21,
  },
  "r-css-11": {
    sha256: "4f5ca29065f81505895796881bce443b68df46f87a1aa36da3b24fe0005af179",
    byteLength: 21,
  },
  "r-css-12": {
    sha256: "3ae347b152804712bcc9115490fa3ac44ce47d4759e7bc835fc7969e2d1858e7",
    byteLength: 21,
  },
  "r-css-13": {
    sha256: "da2184b8764691f1b4b5cbd47d646ed53e0cbb0b7443cc3195d0a7a460dacd4e",
    byteLength: 21,
  },
  "r-css-14": {
    sha256: "885927bea2d18143238bbf571a0480f62a938a9c96e423dcf263f296cf9d21c9",
    byteLength: 21,
  },
  "r-css-15": {
    sha256: "170dcd45caa0b0edff4802897915379dbdb55a2405e8698f1033ab7d3feb7d4d",
    byteLength: 21,
  },
  "r-css-16": {
    sha256: "cc75ca34906f39a4282bb4a453802687041245f43e2424ff3e85bdaf2244f830",
    byteLength: 21,
  },
  "r-css-17": {
    sha256: "1d60dfe1397f51b957eae7a80e5ad5eb0b0292db38c041235bca5314448f86c9",
    byteLength: 21,
  },
  "r-css-18": {
    sha256: "c4d7a3983b0a4043a504f9d7c93861c225823872e3dddad6c22e8b1f60075e5d",
    byteLength: 21,
  },
  "r-css-19": {
    sha256: "4b625cd8c27a1432f2dcc79e770d1671cb515df700913c9fb789409aeb996402",
    byteLength: 21,
  },
  "r-css-20": {
    sha256: "3c00d45c474c1d383eb9bc58689e8bee6dc41ed15447ef0bf8649097bbe5b43d",
    byteLength: 21,
  },
  "r-css-21": {
    sha256: "26f44b4b0edea01d1bcd1ff08b4b7b2dd28c5fb3b217d9d226ff3cd88f133a94",
    byteLength: 21,
  },
  "r-css-22": {
    sha256: "f6039353d876637d65a571bc22385cd0b78103e778a329a84803369c1f492984",
    byteLength: 21,
  },
  "r-css-23": {
    sha256: "75ad292fa73a4f2eddad6561e43d7ff74d9d64d327aed2fd57eb0874487b3c40",
    byteLength: 21,
  },
  "r-css-24": {
    sha256: "f0c964322894024180cc147cd6732c1f832890c065baacf11ae1d303f72dccde",
    byteLength: 21,
  },
  "r-css-25": {
    sha256: "e42b127f64bfb694db617eada0b8ea99c98c9941bb9e0f4df9b60b3d2767aa14",
    byteLength: 21,
  },
  "r-css-26": {
    sha256: "5302e5eb4b0bc4f9ceb8e6261bcbfaa5a999a3220867ad86820c191460925b1b",
    byteLength: 21,
  },
  "r-css-27": {
    sha256: "a0544e6d6488e74c56f9e3d6e92c72cf55721e467c26eae61031cf91c2332e60",
    byteLength: 21,
  },
  "r-css-28": {
    sha256: "bcd74cca2ee0b129a42316d7dba26702b27e87d6e07cdb5aa87de4006bd97fc5",
    byteLength: 21,
  },
  "r-css-29": {
    sha256: "d1723920ea55ded3175b922f46bae9501dd9e38bbceeb9ac92be2fd30c9316ab",
    byteLength: 21,
  },
  "r-css-30": {
    sha256: "273768aec0fa156a5df755b9598d530e560cfed5a58552b55d15bbaeea789405",
    byteLength: 21,
  },
  "r-css-31": {
    sha256: "05415f86dab9ed7ac6082b938fddc705ec0284a9a546d473d156816408a69b35",
    byteLength: 21,
  },
  "r-css-32": {
    sha256: "4d765a6bbd1c321abb765e661a336b21f42da7a2a402c5020eabda4d4c1a5400",
    byteLength: 21,
  },
  "r-css-33": {
    sha256: "5a7b3af857d6b2fccd562ea0e950dcfe7051c0be30ea463459e12243b6ba31cd",
    byteLength: 21,
  },
  "r-css-34": {
    sha256: "44fff2d12f9b139b8be4664887a29574be19049d327e272431fbc5dbd9380dfb",
    byteLength: 21,
  },
  "r-css-35": {
    sha256: "4b0921bfca4a02ce186852b9604462027ca9c802d585aa5d2638ab56294f7e50",
    byteLength: 21,
  },
  "r-css-36": {
    sha256: "788b3d68571776ccaab3cda427b93f907136e935730f934433c3015039cde6db",
    byteLength: 21,
  },
  "r-css-37": {
    sha256: "f19105db47d92305b8ed2dd615da1f12077553ce3e1327c86a46f715c59a3c4c",
    byteLength: 21,
  },
  "r-css-38": {
    sha256: "e2cb6645d824f7e4a25af422f23bcb2a39e70388e422f588b9e92d031994dc4f",
    byteLength: 21,
  },
  "r-css-39": {
    sha256: "d6393febc0f84b01ed57526c3cba8709646ea5a069964e371ae1ae3fa55f2cef",
    byteLength: 21,
  },
  "r-css-40": {
    sha256: "c35ef5e9a305650d8bee5ec703482827693a34705bde40bfa7a5fb1cfb96d1d7",
    byteLength: 21,
  },
  "r-css-41": {
    sha256: "a72e280236e2627a42bc10791728ea2b6f0ca3e84b043d5249c7b16b55cc2a8b",
    byteLength: 21,
  },
  "r-css-42": {
    sha256: "36a88c1e544e2a9bb92cab5e03b4892bc7fe64d8292125b68c59d224e68232bd",
    byteLength: 21,
  },
  "r-css-43": {
    sha256: "fb1e4f0301400c97afd01404bb8a8d455d59972f8d2f4f41486a5ec22fc7daa0",
    byteLength: 21,
  },
  "r-css-44": {
    sha256: "e5a04d520ea3b585d4276937a03f24a9b25c6c268107a537b0d6953a84a49c9d",
    byteLength: 21,
  },
  "r-css-45": {
    sha256: "9f5fde82ff8733e0f9937ee18fc12dd61f5be6f4175f6c696f14b33df1b3ce20",
    byteLength: 21,
  },
  "r-css-46": {
    sha256: "0dc51c3f586e62d4c2ca0b6c7d34e729672acd094d92cc4a02a5a88ff5001c90",
    byteLength: 21,
  },
  "r-css-47": {
    sha256: "4ca78f326dfc5c245ad211be8920dc5e087c97950e1e2fdcc5a0179af43140ba",
    byteLength: 21,
  },
  "r-css-48": {
    sha256: "afb9601c45c47fa36bc6f961b7f4a4303cd1db6848a02d1b22723eb1ac39f81d",
    byteLength: 21,
  },
  "r-css-49": {
    sha256: "87ba371139d9f85e00642c47505f3a705f4d8dd21a3dfb5b45e212ec76882325",
    byteLength: 21,
  },
  "r-js-0": {
    sha256: "87d7597830482d08ddaa6db98fe8848f2bc2edd62b74c0c32df2aeca1c028a4b",
    byteLength: 28,
  },
  "r-js-1": {
    sha256: "d7b8d8216651f820e2213320c315436f8f7e16556a97a2af04be9d2a04b9b76b",
    byteLength: 28,
  },
  "r-js-2": {
    sha256: "1a86a109941f7aae946306924666f1ecf088d6de29a8fa68540505324f43e709",
    byteLength: 28,
  },
  "r-js-3": {
    sha256: "8c00bf1a75dd93e2eb21797eb9c93c58194014ee04d2001c34a8d2986f2837e1",
    byteLength: 28,
  },
  "r-js-4": {
    sha256: "b1f7098e32a4bdfc04b291075b3335c45c1bb5271d0fabd9a6df7b5f29687bba",
    byteLength: 28,
  },
  "r-js-5": {
    sha256: "face6642476435ef052efd338245502427f1630000a1982561384b62c31632b3",
    byteLength: 28,
  },
  "r-js-6": {
    sha256: "31460339c2c40116f7d9d28333c78a1e32dcfc5950b6d42a9707e55afac3ecae",
    byteLength: 28,
  },
  "r-js-7": {
    sha256: "52f360cf43a9d35973dec35b8b401636cd454f3b839f3ec440e4a3bff79d54b0",
    byteLength: 28,
  },
  "r-js-8": {
    sha256: "889c08b0ea9fbff7a389f938c49ed1a71b99b6db91a7de4db558b1ce1a3c89e9",
    byteLength: 28,
  },
  "r-js-9": {
    sha256: "dfec7093be8d51c11672c702ce266625adc04d33a78c82747df24c2a1c43e5c9",
    byteLength: 28,
  },
  "r-js-10": {
    sha256: "89a7919535990af81503b8b4b913c1b3811fb998f64c6f49c5b1cd32f5d09c24",
    byteLength: 29,
  },
  "r-js-11": {
    sha256: "4e2de702c62f1b6264ce2f3a66be1d471e11ee67368252538f011491a020d88d",
    byteLength: 29,
  },
  "r-js-12": {
    sha256: "3bf6cfa10eb7b27549b293d74e3983428b1e03ed8b1c4d5741448cef167f6d65",
    byteLength: 29,
  },
  "r-js-13": {
    sha256: "1371774e1acb5cb34c4cb4fd33d4fcf6180298503b5042593d2e6cccfb6a4398",
    byteLength: 29,
  },
  "r-js-14": {
    sha256: "4296379649161d1ad9cc857daadadb2179babc423803f2ba0e5d7cccbf2b9bc7",
    byteLength: 29,
  },
  "r-js-15": {
    sha256: "a5cf085b2288bcef358a69795809b2945c5ae7eeb742fcbaf6a823ca816d291f",
    byteLength: 29,
  },
  "r-js-16": {
    sha256: "870dcd6cdfb2d77d0447f2f39884d5e454f9c5f427e6f8161da8f0812c5470cd",
    byteLength: 29,
  },
  "r-js-17": {
    sha256: "7b494c9ca467a9adbaa51ad0cfa99f7cb720c6bbecea1382e75e5fd029751733",
    byteLength: 29,
  },
  "r-js-18": {
    sha256: "e95dc8089a4cbd1ed585fa37e5bea3b13a5a23857036b5acc8daa4abbe3681ee",
    byteLength: 29,
  },
  "r-js-19": {
    sha256: "fc1ecbab3405effe8856573666adb393d3f2f8654aa8553dce177fdd81f76abb",
    byteLength: 29,
  },
  "r-js-20": {
    sha256: "018d47f52efb007feba878151643d0dc80af1f060522bb610b62321c3ac9bb18",
    byteLength: 29,
  },
  "r-js-21": {
    sha256: "4926e261883c2d86edd7fcdf777979309e94c2a8e08e72516aaf074e9b46cecf",
    byteLength: 29,
  },
  "r-js-22": {
    sha256: "4afb342808a63ca54a340e3b2bd615f34665ef3d81d9ed2104bbfcf6eb14b3b1",
    byteLength: 29,
  },
  "r-js-23": {
    sha256: "502e6c17711f7753244d735eca41de03645f3f02a5584b7c54a7855ccb3dd50b",
    byteLength: 29,
  },
  "r-js-24": {
    sha256: "cf7560fdd0390ccaade2299512e4e30953a17b930fc34edeb44a11f39c389722",
    byteLength: 29,
  },
  "r-js-25": {
    sha256: "d7ca10448c6f41ddf63f1b1176f9921331cffe8097f29e15c4a45f71ad4a4c63",
    byteLength: 29,
  },
  "r-js-26": {
    sha256: "c8990d167565d42bde856fc60f6244138454e42dddcc3cd58602356e84bdde16",
    byteLength: 29,
  },
  "r-js-27": {
    sha256: "79d79468d056048e76fd43dc79fe4bb12243f1003da855fd6b5ebeddebb3f720",
    byteLength: 29,
  },
  "r-js-28": {
    sha256: "b189562c244cc91f7ba532e203b69c34bb5af151fa799985afb412ed448a85b8",
    byteLength: 29,
  },
  "r-js-29": {
    sha256: "dc68290eeb5e46f701cf08708a575b9be63fa60562a99c1b62c88354bacaad51",
    byteLength: 29,
  },
  "r-js-30": {
    sha256: "62dc21e32d8a8178a10c7f0e6be060a3893f67ad5c594808e748ae28e139e0e2",
    byteLength: 29,
  },
  "r-js-31": {
    sha256: "d5f51de0ea37b25e9f038710519c66c36781d13edce10d870da048e10e65f660",
    byteLength: 29,
  },
  "r-js-32": {
    sha256: "5a8f4741d41661930e22c31e074e501f213d072735ed41ad8d857684ee2685c6",
    byteLength: 29,
  },
  "r-js-33": {
    sha256: "90299ae2ff4830b1c803a5ada2affd069da77913de0c0a36694050c0fea3cd00",
    byteLength: 29,
  },
  "r-js-34": {
    sha256: "4ffa1454e3176b35542da974dddc988608943084ae2b8aee0848046c2f7da27f",
    byteLength: 29,
  },
  "r-js-35": {
    sha256: "00a98166b58043cd47e261ad2d94ae81352251402afdab134c57300c999e69ad",
    byteLength: 29,
  },
  "r-js-36": {
    sha256: "1cb82a9a2b5ab55b43960c0fa6e6a89d96eaabe2a874f40697c6330d3a70e50c",
    byteLength: 29,
  },
  "r-js-37": {
    sha256: "c18b707cc3da6c825adfb103d0a9d16e7b65a7fdc32657c1759b82affebe3c4e",
    byteLength: 29,
  },
  "r-js-38": {
    sha256: "7375dce701ed24825828f6c7817b9bf3493ffa1995ff24eac98d36829714fe6e",
    byteLength: 29,
  },
  "r-js-39": {
    sha256: "6ddbe96d2bbf70e174a07c60e381bca6f1febbdf8ef08e369c8b10dcbece3e8a",
    byteLength: 29,
  },
  "r-js-40": {
    sha256: "28ba75cf6e5c30977d0e8e8945167b788ffe2c626369abe99a526630e1e0a77f",
    byteLength: 29,
  },
  "r-js-41": {
    sha256: "312e19b911eba3752090f70d434f9845847d05aa3c8f333b4ee3129b95f1f56c",
    byteLength: 29,
  },
  "r-js-42": {
    sha256: "7ff0236070d9eea31e401b6d3a7da783924f7209c22176894773f50bd407ae53",
    byteLength: 29,
  },
  "r-js-43": {
    sha256: "ff0525d5cd86de03e55a0010c5c2b6b4b014d41a81693a125890e25a2c67d429",
    byteLength: 29,
  },
  "r-js-44": {
    sha256: "01f9735a32a54070002eb21cec0f25b9f5d13015e1c8de2dd6508ac35f6562a7",
    byteLength: 29,
  },
  "r-js-45": {
    sha256: "b73279c2bb50268be3f5b2ea592d86fd045254377ad268b02dba80cabadd3b90",
    byteLength: 29,
  },
  "r-js-46": {
    sha256: "29c9e6ab9abfd2bb6d30b54452f7cbafdb0bfe038a8d7e82d5fd67bcb78b4caa",
    byteLength: 29,
  },
  "r-js-47": {
    sha256: "954b238b552dc9fd2d85ca3ce1371770d0f5bb3bb7fed5d35875cb5558a04814",
    byteLength: 29,
  },
  "r-js-48": {
    sha256: "40bb7caac260a0a5beff37d7d79396339a556a4eb1e28d2a058f83529fc23566",
    byteLength: 29,
  },
  "r-js-49": {
    sha256: "c61c9d9487b3f9b62160e6c6ae3c795ab05842f56f5445399b3444666188f485",
    byteLength: 29,
  },
  "r-image-0": {
    sha256: "154fba67a91a424c486518ea9fde20b2fdb4cec3c239140c13703ac1e92f65a0",
    byteLength: 110,
  },
  "r-image-1": {
    sha256: "260bfba0a9a3915ec74b501735c1b80ac3b63f172758da5fbad04de84b89bd82",
    byteLength: 110,
  },
  "r-image-2": {
    sha256: "d0cd79e33acff3f1668b0d3b5ec2f0abded434249c0de69c70ad97118c9d5448",
    byteLength: 110,
  },
  "r-image-3": {
    sha256: "d98cff3485ac02f0eb2eb6d6668415b63ff8ea351ecb31b98c0171d21001cc6a",
    byteLength: 110,
  },
  "r-image-4": {
    sha256: "86f41876b52b108c7f623fa8816552077b48b4e458a50fb64cc3939a4c1978a0",
    byteLength: 110,
  },
  "r-image-5": {
    sha256: "6d10984d23c5effd0022982f578a4141c9936020f1c5178ff718c1b8ea3bebf3",
    byteLength: 110,
  },
  "r-image-6": {
    sha256: "2816307e8ce19ac9b7fdd4b82325743c467dd3e4443626f54f56773b11513ae4",
    byteLength: 110,
  },
  "r-image-7": {
    sha256: "0ed6c1ce82e1123041f95e3e6a47c0d624aec9be6ee8a6f7269e84a35b202872",
    byteLength: 110,
  },
  "r-image-8": {
    sha256: "00ab92ae04ffc4b6526add7c1d80386bb8c9a6a3614c22030fd5ebfe8289f15b",
    byteLength: 110,
  },
  "r-image-9": {
    sha256: "6604584731f36961cd8de0652be01c9a512fdc2ccf84d926b68b317752bce8cf",
    byteLength: 110,
  },
  "r-image-10": {
    sha256: "9d14cbe8dd7a562277b60b581fe1fa07003f052908d34b512445c1b864cae0b0",
    byteLength: 110,
  },
  "r-image-11": {
    sha256: "61e08ebd7fabfb2eee27df95cd722dc36bb0f93bcb5fa8a757926a92fbe90940",
    byteLength: 110,
  },
  "r-image-12": {
    sha256: "39ed9982d0b419faeffd3a0f6e224954e33ef875832c81fbd429c34860383c39",
    byteLength: 110,
  },
  "r-image-13": {
    sha256: "cfd2131b13aff3f9d4f545e2a7a6eae0b7e8929b834b304f8bed17d566e9bfc7",
    byteLength: 110,
  },
  "r-image-14": {
    sha256: "640080e4111942c3303650b88b89b185548fe4f1264614fc18dd2ccc5ce60faf",
    byteLength: 110,
  },
  "r-image-15": {
    sha256: "353778e596c242d3bc25f4731b31a13a0b9ed78bcc31cfc2ee58234d7a990b5d",
    byteLength: 110,
  },
  "r-image-16": {
    sha256: "5fdf3b10644cb778f8e625f109f99a57b66dd990845bc74b8b369ac32b357833",
    byteLength: 110,
  },
  "r-image-17": {
    sha256: "94333d5d37df2441837a313600440ae991d1cf015c8a70fad1f4feb65fae0899",
    byteLength: 110,
  },
  "r-image-18": {
    sha256: "8883562d0c63e05aa04acc93ea91711c66a8e9087fe5fe09046274b8c25509d8",
    byteLength: 110,
  },
  "r-image-19": {
    sha256: "ce77c6867cf7c1cbb02a5c6fde2d74ea2ec8bc8d8ff3d9282f41142cb3b63100",
    byteLength: 110,
  },
  "r-image-20": {
    sha256: "07e3b8fe508fddf2497994a70a25c648576e38e9d1404ae9d7f7be199acc001b",
    byteLength: 110,
  },
  "r-image-21": {
    sha256: "ab509a57a9cbc81da8bb64ee768cd0bbc19981167e0bbcdb240bea65d8ed0a26",
    byteLength: 110,
  },
  "r-image-22": {
    sha256: "e9b398de835670f0d8b1978e92b081488ce177a036074e3fa474bc4fbed5dbd6",
    byteLength: 110,
  },
  "r-image-23": {
    sha256: "d269deaad6d36120a1e3d39e1efd5bdfc966aa9cfee94c6224eb8d587accc4ef",
    byteLength: 110,
  },
  "r-image-24": {
    sha256: "7a78283755e431e08b903204258d5dd002821ab7c6a79f439ed531c336d34222",
    byteLength: 110,
  },
  "r-image-25": {
    sha256: "166bfe1034bf150df180b672a08441f21b3802bc6200dbb926b2af892bf11aa8",
    byteLength: 110,
  },
  "r-image-26": {
    sha256: "267b14b5a2de41a4ad44f0c78fd10901295f001712c6080e9b4828fb286a7d00",
    byteLength: 110,
  },
  "r-image-27": {
    sha256: "500ff4f6241ac5c65b148c7820fa73cf48aa16bf70644f3de3f863597099dbb0",
    byteLength: 110,
  },
  "r-image-28": {
    sha256: "d378929e47d0eceb1367008554b84bddea8973a43405ba3fb31b2fff05141927",
    byteLength: 110,
  },
  "r-image-29": {
    sha256: "2ebcc58c562200230d99688797eddfb37e3ad1bad913ae124be16fbf55300a3b",
    byteLength: 110,
  },
  "r-image-30": {
    sha256: "03976169b7eec0d853899c97e44099db6dd2675775d99f209651d44be756da0a",
    byteLength: 110,
  },
  "r-image-31": {
    sha256: "b4d5518ffd35ae8f312b102bfb7dba9972b49cfeed033af5a6bb20ed0fe142a2",
    byteLength: 110,
  },
  "r-image-32": {
    sha256: "50e951b8947573384bf3c2802b3c35692d32a1de738a54a91c3bb7865598d5e7",
    byteLength: 110,
  },
  "r-image-33": {
    sha256: "9e09a7ffb5f5933a709169e3d9f5e952aa01cc7f18542ef12004abff4ad03679",
    byteLength: 110,
  },
  "r-image-34": {
    sha256: "7e1ee7aecf0d5fdc7cd46fbea8ccc132239e80080520addb9c1b607858ffbb9e",
    byteLength: 110,
  },
  "r-image-35": {
    sha256: "7009ef766c99b78ce03c3a005be4ade2d29b995de83a3f4188d84614766a44f8",
    byteLength: 110,
  },
  "r-image-36": {
    sha256: "3a1626f156ab752631c8530c64d5f06ba98a086cc0081a130fe0a62ba00c53ce",
    byteLength: 110,
  },
  "r-image-37": {
    sha256: "11f6aed650e9ae178dd794caded65118af827e2a15481844cb4b28950e117439",
    byteLength: 110,
  },
  "r-image-38": {
    sha256: "9286722af06784bdccb468fe74a9b0774c643e3f21a7569682540c0b8c542cfc",
    byteLength: 110,
  },
  "r-image-39": {
    sha256: "bd86704c5f9dd5add7675600f0848849473a1be2f9768b90e566fc1ebb5f1a7b",
    byteLength: 110,
  },
  "r-image-40": {
    sha256: "f50d341aed06a610fc6837e4a5607245ac2df69cfa7d9d41613c171c07f78649",
    byteLength: 110,
  },
  "r-image-41": {
    sha256: "4333842d5908bea5a2e37a9097f1928cfed443aff33035d835d00f74bc45b139",
    byteLength: 110,
  },
  "r-image-42": {
    sha256: "bed77b41041b03b59257ddfe6dd16171de7221f8508259461b6af7f17d1ebb66",
    byteLength: 110,
  },
  "r-image-43": {
    sha256: "56292f8dd252546859915c4225e6519e2357437314075b56c2997f3c992a1ce4",
    byteLength: 110,
  },
  "r-image-44": {
    sha256: "135878b8129d35671291c8afe59286c59809bb0a5198b697b14c6ac56f9d1ae5",
    byteLength: 110,
  },
  "r-image-45": {
    sha256: "45381b66f480b876d31704b9ecc422ed0cab76cfe80978b2a2ee1ea34f5b2768",
    byteLength: 110,
  },
  "r-image-46": {
    sha256: "d8ec0d375a80d622532d85ffe82b54b88fadf02cfaf07b55bc9f632051300e8b",
    byteLength: 110,
  },
  "r-image-47": {
    sha256: "fa1549fff3ede74f763735c5412bc4e592b0c07965e6ef7db917deb93d85d269",
    byteLength: 110,
  },
  "r-image-48": {
    sha256: "42c557b352bf33442c0fcdda6acb22819c20894ff239191192e0aa344becf22c",
    byteLength: 110,
  },
  "r-image-49": {
    sha256: "b900b651910640aedc6b04727ccd90244773c716df7cffdfef1f00c93a029036",
    byteLength: 110,
  },
  "r-json-0": {
    sha256: "19003781a88238a11984a1fdaf8660686302f2a4c272948b49aa15548563c0c7",
    byteLength: 50,
  },
  "r-json-1": {
    sha256: "40a13ca3857657f1edcda49084e5c64c9dd66d9b2ab8e0bf034a58e36f965b98",
    byteLength: 50,
  },
  "r-json-2": {
    sha256: "1e803f7230f5831715badb6c27a705301d486fa322cc1292726c0c57dc80cfc9",
    byteLength: 50,
  },
  "r-json-3": {
    sha256: "cfa4e990164c52e8d3334b5b7b82e11341677def39ade20ee2442b12ec51a9ff",
    byteLength: 50,
  },
  "r-json-4": {
    sha256: "07ef1d3387bdc77a3b6bdaa3db528c522e77e3ca6766a609281b1c4e1bac7c92",
    byteLength: 50,
  },
  "r-json-5": {
    sha256: "27783924bbfa82cba60aa28fa30abdad2c8f0bb3a3ac11880b24b33f32337e9a",
    byteLength: 50,
  },
  "r-json-6": {
    sha256: "4daa67994f94e1262b3cbb4e0e016e3f8494f75991b926155e4c1a5fd2e5a32c",
    byteLength: 50,
  },
  "r-json-7": {
    sha256: "49608cc0fef3a2704e1fc36ff23f0a829215c980216329aa17fc9e2cf0316f33",
    byteLength: 50,
  },
  "r-json-8": {
    sha256: "8ee4ca38b42b7580aa2dea5f2ee08a2fc0366ad840231aa52480491078c2ac53",
    byteLength: 50,
  },
  "r-json-9": {
    sha256: "e1be9f44cfa1f7cc6be1591069d3e0bf72420355f6acd7923454d6143597cfe0",
    byteLength: 50,
  },
  "r-json-10": {
    sha256: "e097813c8263773b55b7b7fd3be355292019c49e89e92411f48e2ce962750eeb",
    byteLength: 51,
  },
  "r-json-11": {
    sha256: "71c85fcbd23673cc47a14c4a518acdb352d4bf2a9e6dfb800b81d29fe1afc5ef",
    byteLength: 51,
  },
  "r-json-12": {
    sha256: "d8cb717ce0e8b3be4e361b712d3fc7efe30e4b849746731bf6993c04d95a8ada",
    byteLength: 51,
  },
  "r-json-13": {
    sha256: "462e1b8d292c5efca278fa5e2b06f4e090c8fcb1fd651bfce2798aa848bf5433",
    byteLength: 51,
  },
  "r-json-14": {
    sha256: "0b48bae72fe348fdf44a04c441ee0533bd810b918005ecab43a286d841d0a5a9",
    byteLength: 51,
  },
  "r-json-15": {
    sha256: "81ac73d8c27b30bb0c73e73ebcc1ad2047a3e2dd5eb24517982b19de4a8e4f5b",
    byteLength: 51,
  },
  "r-json-16": {
    sha256: "be50cc3bbcd79b33ec2fd47161e3e191e93a97feb1e15986d0ce7c5b235188d5",
    byteLength: 51,
  },
  "r-json-17": {
    sha256: "5be40cd6a03ff3898cc38d73913e1c6cdf3e7b03db91d8eab4b689e714e8996a",
    byteLength: 51,
  },
  "r-json-18": {
    sha256: "126ace92b3b81fa6ff9114e0fd9a85ad9c1407ceff9320946f914f58e6d59610",
    byteLength: 51,
  },
  "r-json-19": {
    sha256: "12040ec6715e7ad3dda4d80fa725f1bffdb56b5dd19f2b7ae216c67189b1cde1",
    byteLength: 51,
  },
  "r-json-20": {
    sha256: "d963aa2aa6041205c5777f6371fd17e6eaf9b3c92d298cb3f466ef9839e7426c",
    byteLength: 51,
  },
  "r-json-21": {
    sha256: "a2407645dd20a7d41ff8d4c7802af3dd80e35c28059a68e1c564dddaa2e0984a",
    byteLength: 51,
  },
  "r-json-22": {
    sha256: "3f301f17a2a663977684ec96ef3803c5bb91f945e5bd128a0ba7ac5e093d0baa",
    byteLength: 51,
  },
  "r-json-23": {
    sha256: "41b5ed7714de17bcd410f888e0b45dcde2872b44fe491476fb7edeb0408def52",
    byteLength: 51,
  },
  "r-json-24": {
    sha256: "fa85e2435d1e657792ff97fe61930222c963aacb7833c42ec13749b5aeed6e5f",
    byteLength: 51,
  },
  "r-json-25": {
    sha256: "64ba3fea002c421024c60bd1eb4c0bf5ce903ce6d28c2dc16622bff716db5bd1",
    byteLength: 51,
  },
  "r-json-26": {
    sha256: "b14d12b7799c9c9307a25fca8061a6a1f07ad67891a900c8816449107254ace6",
    byteLength: 51,
  },
  "r-json-27": {
    sha256: "2c75ced8e143910c073dedc957e163b7c5c3cfb5642cbe807a6be46d6a83a07b",
    byteLength: 51,
  },
  "r-json-28": {
    sha256: "58f7ac373320e720e28ad855b5849dbc03896a8418437bc18ba4bd49c0573c50",
    byteLength: 51,
  },
  "r-json-29": {
    sha256: "ce21560ae84294f57312871bd856e74e3a2d11d20c99262457f7e155860a8c0c",
    byteLength: 51,
  },
  "r-json-30": {
    sha256: "f5760669360bd918da6e37f24fb464172096ef4fd171cbb75295c6654174f6e9",
    byteLength: 51,
  },
  "r-json-31": {
    sha256: "b1df1de72df1eeb4d7462aed5f152a3494a6fa34635d690283ddd3d35446f0fe",
    byteLength: 51,
  },
  "r-json-32": {
    sha256: "446e85fc2be77ca12c3410fb0b0b9058414bcb2d8226f28fbd5c297a90aaf724",
    byteLength: 51,
  },
  "r-json-33": {
    sha256: "c011ae35f438331d3c55e547e71f1da55320516e61d0d77c88b04010cd825d71",
    byteLength: 51,
  },
  "r-json-34": {
    sha256: "c9f3159066b77cdc4fa85e7a6bfe077005ab16f0ffa797ff6e217e24e2fcb8fc",
    byteLength: 51,
  },
  "r-json-35": {
    sha256: "bfe6776235983f21745c024dc425afcc8bc9e369b0a260e22a85c1d5133ed770",
    byteLength: 51,
  },
  "r-json-36": {
    sha256: "09bdef58b9703b716fe3aa6b6275040d2ac3468727c146db17c6a786385f0de4",
    byteLength: 51,
  },
  "r-json-37": {
    sha256: "c0e8a22895eacc13b3eb3039fec978c43f7bfd39457a6dee009232a3a3fe8ae4",
    byteLength: 51,
  },
  "r-json-38": {
    sha256: "7760d09490f510219c9e9e30427c39d91aefa456cfcb6c8eb89026d6bc8a50de",
    byteLength: 51,
  },
  "r-json-39": {
    sha256: "612fcd6c7175897ce2bb0da4755bbff6bbf5f54f45dc760bce566a17c54272d2",
    byteLength: 51,
  },
  "r-json-40": {
    sha256: "8c0bc03e936594d16ae4219878e6bde34643d5eab954c515c418dd2b6d348e06",
    byteLength: 51,
  },
  "r-json-41": {
    sha256: "52bd817e4c7b4f5e706f03ad6d200f9fad6b31549bc4fdef3864def047d2ed75",
    byteLength: 51,
  },
  "r-json-42": {
    sha256: "7302b71cb9ab77dbb6805f59e1666a286f48f9e499d17e7c6fd686d23ba0d541",
    byteLength: 51,
  },
  "r-json-43": {
    sha256: "72c3bd5cca45aab637eee1657711cedc3e1b555064af18054dba1b90713c663f",
    byteLength: 51,
  },
  "r-json-44": {
    sha256: "23019956f3d8bebc9ebc03a7b009c9c9cd5a7613976df8588e4374f334fbfcdd",
    byteLength: 51,
  },
  "r-json-45": {
    sha256: "0394ee182ca2609df6386becc8078f45dc2169d44bfcc20761df75b9090c5e60",
    byteLength: 51,
  },
  "r-json-46": {
    sha256: "173acfd069439f42209ad17af694d87736ee9a862e0a5c377941dab65cf674b2",
    byteLength: 51,
  },
  "r-json-47": {
    sha256: "39e26889e94f4682b362a3489ba8eca6ba6acb2bc632305c201aabcc86a67be4",
    byteLength: 51,
  },
  "r-json-48": {
    sha256: "eba59c35979f00ad8e4542dac561bb54825eb2c6c5165939573be78b0e779b82",
    byteLength: 51,
  },
  "r-json-49": {
    sha256: "1be082e31ff4135de65c65775c1552f8f19dba9ae999ec618fe1a755b9279fee",
    byteLength: 51,
  },
};
