import { waitUntil, WAIT_FOREVER } from "async-wait-until";

var isDebug = window.name?.includes("Debug") || false;

window.addEventListener(
  "message",
  ({ data }) => {
    if (data.type === "segmentBox") {
      segmentBox(data);
    } else if (data.type === "resizeImage") {
      resizeImage(data);
    }
  },
  false
);

async function segmentBox(request, isResize = true) {
  var type = "segmentSuccess";
  var resultBboxList = [];
  var base64 = request.base64Url;
  var ratio = 1;
  var mode = request.mode;
  var opencvImg;

  try {
    await waitOpencvLoad();

    //get image
    var canvas1 = await loadImage(request.base64Url);
    var [canvas1, ratio] = preprocessImage(canvas1, isResize);
    base64 = canvas1.toDataURL();

    // get bbox from image
    var { bboxList, preprocessedSourceImage } = detectText(canvas1, mode);

    if (preprocessedSourceImage && mode.includes("useOpencvImg")) {
      base64 = opencvMatToBase64(preprocessedSourceImage);
    }

    resultBboxList = resultBboxList.concat(bboxList);
  } catch (err) {
    console.log(err);
    type = "segmentFail";
  }

  response({
    type,
    mainUrl: request.mainUrl,
    base64Url: base64,
    lang: request.lang,
    bboxList: resultBboxList,
    opencvImg,
    ratio,
    windowPostMessageProxy: request.windowPostMessageProxy,
  });
}

async function waitOpencvLoad() {
  await waitUntil(() => {
    try {
      let mat = cv?.matFromArray(2, 3, cv?.CV_8UC1, [1, 2, 3, 4, 5, 6]);
      return mat?.cols;
    } catch (error) {
      console.log(error);
    }
    return "";
  });
}

async function resizeImage(request) {
  var canvas1 = await loadImage(request.base64Url);
  var [canvas2, ratio] = preprocessImage(canvas1);
  base64 = canvas2.toDataURL();

  response({
    base64Url: base64,
    cvratio: ratio,
    windowPostMessageProxy: request.windowPostMessageProxy,
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    var image = new Image(); //image get

    image.onload = () => {
      var canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d").drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = reject;
    image.src = url;
  });
}

function response(data) {
  window.parent.postMessage(data, "*");
}

// opencv=========================================
function detectText(canvasIn, mode) {
  // https://github.com/qzane/text-detection

  let src = cv.imread(canvasIn);
  let dst = new cv.Mat();
  var bboxList = [];
  var w = src.cols;
  var h = src.rows;
  var paddingSize = 10;
  let contours = new cv.MatVector();
  let hierarchy = new cv.Mat();
  var preprocessedSourceImage;

  if (mode.includes("small")) {
    var ksize = new cv.Size(12, 12);
    var element = cv.getStructuringElement(cv.MORPH_RECT, ksize);
    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
  } else if (mode.includes("black") || mode.includes("white")) {
    var ksize = new cv.Size(15, 15);
    var element = cv.getStructuringElement(cv.MORPH_RECT, ksize);

    // Invert colors for black mode
    if (mode.includes("black")) {
      cv.bitwise_not(src, src);
    }

    // Convert image to grayscale and ensure single-channel
    // Threshold to get white areas
    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
    cv.threshold(dst, dst, 200, 255, cv.THRESH_BINARY);
    showDebugImage(dst, mode);
    
    // Create floodfill masks for each edge
    let combinedFloodMask = new cv.Mat(
      dst.rows,
      dst.cols,
      cv.CV_8U,
      new cv.Scalar(0)
    );
    var combinedFloodVisited = new Set();
    const corners = [
      { x: 0, y: 0 },
      { x: dst.cols - 1, y: 0 },
      { x: 0, y: dst.rows - 1 },
      { x: dst.cols - 1, y: dst.rows - 1 },
    ];
    corners.forEach((corner) => {
      combinedFloodMask = customFloodFillWithoutCv(
        dst,
        corner,
        combinedFloodMask,
        combinedFloodVisited
      );
    });
    // showImage(combinedFloodMask, mode);
    // Remove mask area that exists in combinedFloodMask
    cv.bitwise_not(dst, dst);
    cv.bitwise_or(dst, combinedFloodMask, dst);
    cv.bitwise_not(dst, dst);
    showDebugImage(dst, mode);

    cv.copyMakeBorder(
      dst,
      dst,
      1,
      1,
      1,
      1,
      cv.BORDER_CONSTANT,
      new cv.Scalar(0)
    );
    // Flood fill the mask to get the white area
    let floodFillMask = customFloodFillWithoutCv(dst, { x: 0, y: 0 });
    cv.bitwise_not(floodFillMask, floodFillMask);
    floodFillMask = floodFillMask.roi(
      new cv.Rect(1, 1, floodFillMask.cols - 2, floodFillMask.rows - 2)
    );
    let slicedResultMask = new cv.Mat();
    cv.bitwise_and(src, src, slicedResultMask, floodFillMask);
    showDebugImage (slicedResultMask, mode);

    // // make white background and combine with slicedResultMask
    cv.bitwise_not(floodFillMask, floodFillMask);
    cv.cvtColor(floodFillMask, floodFillMask, cv.COLOR_GRAY2RGBA, 0);
    cv.bitwise_or(slicedResultMask, floodFillMask, floodFillMask);
    showDebugImage(floodFillMask, mode);
    
    // Enhance color saturation
    let enhancedImage = new cv.Mat();
    cv.cvtColor(floodFillMask, enhancedImage, cv.COLOR_RGBA2RGB, 0);
    cv.bitwise_not(enhancedImage, enhancedImage); // Ivert colors
    cv.convertScaleAbs(enhancedImage, enhancedImage, 2.0, 0); // Adjust intensity
    cv.bitwise_not(enhancedImage, enhancedImage); // Invert colors
    cv.convertScaleAbs(enhancedImage, enhancedImage, 1.5, 0); // Increase intensity
    preprocessedSourceImage = enhancedImage;
    showDebugImage(preprocessedSourceImage, mode);

    // Update src and dst with the sliced result
    src = floodFillMask;
    dst = preprocessedSourceImage.clone();
    cv.cvtColor(dst, dst, cv.COLOR_RGBA2GRAY, 0);
  } else if (mode.includes("contour")) {
    var ksize = new cv.Size(12, 12);
    var element = cv.getStructuringElement(cv.MORPH_RECT, ksize);
    let elementDilate = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));

    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(dst, dst, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(dst, dst, 30, 150, 3, false);
    
    // 2. 외곽선 추출
    cv.findContours(
      dst,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );
    showDebugImage(dst, mode);


    // 3. 마스크 생성 (말풍선 내부를 흰색으로 채움)
    let mask = new cv.Mat(h, w, cv.CV_8U, new cv.Scalar(0));
    cv.drawContours(mask, contours, -1, new cv.Scalar(255), -1); // 내부 채움
  
    cv.dilate(mask, mask, elementDilate, new cv.Point(-1, -1), 2, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue());


    showDebugImage(mask, mode);


    
    // 4. 마스크를 이용해서 원본 이미지에서 말풍선 영역만 추출
    let result = new cv.Mat();
    src.copyTo(result, mask); // mask가 255인 부분만 복사됨
    src= result.clone(); // src에 결과 저장
    // dst= result.clone(); // dst에 결과 저장
    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);

    // 5. 결과 확인
    showDebugImage(result, mode);
  } else {
    //get only contour bounded image to extract manga bubble only
    var ksize = new cv.Size(15, 15);
    var element = cv.getStructuringElement(cv.MORPH_RECT, ksize);
    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
    cv.GaussianBlur(dst, dst, new cv.Size(5, 5), 0, 0, cv.BORDER_DEFAULT);
    cv.Canny(dst, dst, 30, 150, 3, false);
    cv.findContours(
      dst,
      contours,
      hierarchy,
      cv.RETR_EXTERNAL,
      cv.CHAIN_APPROX_SIMPLE
    );
    showDebugImage(dst, mode);

    // # Create a mask from the contours, 1for bounded, 2for non bounded, bold not bold
    let mask1 = new cv.Mat(h, w, cv.CV_8U, new cv.Scalar(0));
    cv.drawContours(mask1, contours, -1, new cv.Scalar(255), -1);
    let mask2 = new cv.Mat(h, w, cv.CV_8U, new cv.Scalar(0, 0, 0));
    cv.drawContours(mask2, contours, -1, new cv.Scalar(255), 5);
    cv.bitwise_not(mask2, mask2);
    showDebugImage(mask1, mode);
    showDebugImage(mask2, mode);

    // # Bitwise-AND bounded mask with the non bounded mask to remove edges
    let area_bounded_contour_mask = new cv.Mat();
    cv.bitwise_and(mask1, mask1, area_bounded_contour_mask, mask2);
    showDebugImage(area_bounded_contour_mask, mode);


    cv.cvtColor(src, dst, cv.COLOR_RGBA2GRAY, 0);
    cv.bitwise_and(dst, dst, dst, area_bounded_contour_mask);
    let area_bounded_contour_mask_inv = new cv.Mat();
    cv.bitwise_not(area_bounded_contour_mask, area_bounded_contour_mask_inv);
    showDebugImage(area_bounded_contour_mask, mode);

    let y = new cv.Mat();
    cv.add(area_bounded_contour_mask_inv, dst, y);
    src = y;
    dst = y;
    paddingSize = 3;
    showDebugImage(dst, mode);
    // blurred = cv2.GaussianBlur(gray, (5,5), 0)
    // edges = cv2.Canny(blurred, 50, 200,apertureSize=7,L2gradient=True)
  }
  // var ksize = new cv.Size(20, 20);
  // var element = cv.getStructuringElement(cv.MORPH_ELLIPSE, ksize);
  // cv.erode(dst, dst, delement);
  // cv.dilate(dst, dst, delement);
  // cv.medianBlur(dst, dst, 5);

  cv.threshold(dst, dst, 0, 255, cv.THRESH_OTSU | cv.THRESH_BINARY);
  cv.Sobel(dst, dst, cv.CV_8U, 1, 0, 1, 1, 0, cv.BORDER_DEFAULT); //x1,y0,ksize3,
  cv.Sobel(dst, dst, cv.CV_8U, 0, 1, 1, 1, 0, cv.BORDER_DEFAULT); //x1,y0,ksize3, remove straight line

  cv.threshold(dst, dst, 0, 255, cv.THRESH_OTSU | cv.THRESH_BINARY); //remove smooth color diff
  cv.morphologyEx(dst, dst, cv.MORPH_CLOSE, element); //make bigger for char grouping
  cv.findContours(
    dst,
    contours,
    hierarchy,
    cv.RETR_EXTERNAL,
    cv.CHAIN_APPROX_NONE
  );

  for (let i = 0; i < contours.size(); ++i) {
    let cnt = contours.get(i);
    let area = cv.contourArea(cnt);
    let angle = Math.abs(cv.minAreaRect(cnt).angle);
    let isRightAngle = [0, 90, 180, 270, 360].some(
      (x) => Math.abs(x - angle) <= 20.0
    );
    let rect = cv.boundingRect(cnt);
    var left = parseInt(Math.max(rect.x - paddingSize, 0));
    var top = parseInt(Math.max(rect.y - paddingSize, 0));
    var width = parseInt(Math.min(rect.width + paddingSize * 2, w - left));
    var height = parseInt(Math.min(rect.height + paddingSize * 2, h - top));
    // var whRatio = Math.max(width / height, height / width);
    var rectCoverRatio = area / (rect.width * rect.height);

    // if not sharp, small size, wrong angle, too side pos
    if (
      rectCoverRatio < 0.15 ||
      cnt.rows < 100 ||
      area < 150 ||
      !isRightAngle
      // left == 0 ||
      // top == 0
      // left + width == w ||
      // top + height == h
    ) {
      continue;
    }

    var bbox = { left, top, width, height };
    bboxList.push(bbox);

    if (isDebug) {
      let color = new cv.Scalar(
        Math.round(Math.random() * 255),
        Math.round(Math.random() * 255),
        Math.round(Math.random() * 255)
      );
      let point1 = new cv.Point(left, top);
      let point2 = new cv.Point(left + width, top + height);
      cv.rectangle(src, point1, point2, color, 2, cv.LINE_AA, 0);
    }
  }

  for (let i = 0; i < bboxList.length; i++) {
    for (let j = i + 1; j < bboxList.length; j++) {
      let rect1 = bboxList[i];
      let rect2 = bboxList[j];

      // Check if rectangles overlap
      if (
        rect1.left < rect2.left + rect2.width &&
        rect1.left + rect1.width > rect2.left &&
        rect1.top < rect2.top + rect2.height &&
        rect1.top + rect1.height > rect2.top
      ) {
        // Create a new rectangle that encompasses both
        let newRect = {
          left: Math.min(rect1.left, rect2.left),
          top: Math.min(rect1.top, rect2.top),
          width:
            Math.max(rect1.left + rect1.width, rect2.left + rect2.width) -
            Math.min(rect1.left, rect2.left),
          height:
            Math.max(rect1.top + rect1.height, rect2.top + rect2.height) -
            Math.min(rect1.top, rect2.top),
        };

        // Replace rect1 with the new rectangle and remove rect2
        bboxList[i] = newRect;
        bboxList.splice(j, 1);
        j--; // Adjust index after removal
      }
    }
  }


  // console.log(mode)
  // console.log(bboxList.length);
  showDebugImage(src, mode);
  showDebugImage(dst, mode);

    
  bboxList = sortBbox(bboxList);
  return { bboxList, preprocessedSourceImage };
}

function showDebugImage(cvImage, mode) {
  if (!isDebug) {
    return;
  }

  console.log(mode);
  var canvas = document.createElement("canvas");
  cv.imshow(canvas, cvImage);
  document.body.appendChild(canvas);
}

function sortBbox(bboxList) {
  return bboxList.sort((a, b) => {
    if (a.top < b.top) {
      return -1;
    }
  });
}

function image_resize(src, minSize) {
  var dim;
  var r;
  var w = src.cols;
  var h = src.rows;

  if (!minSize) {
    return src;
  } else if (h < w) {
    r = minSize / h;
    dim = [parseInt(w * r), minSize];
  } else {
    r = minSize / w;
    dim = [minSize, parseInt(h * r)];
  }

  let dsize = new cv.Size(...dim);
  cv.resize(src, src, dsize, 0, 0, cv.INTER_AREA);
  return r;
}

function preprocessImage(canvasIn, isResize) {
  var canvasOut = document.createElement("canvas");
  var ratio = 1;
  let src = cv.imread(canvasIn);
  let dst = new cv.Mat();

  cv.cvtColor(src, src, cv.COLOR_RGBA2GRAY, 0);

  if (isResize) {
    var ratio = image_resize(src, 700);
  }

  cv.imshow(canvasOut, src);
  src.delete();
  dst.delete();

  return [canvasOut, ratio];
}

function customFloodFillWithoutCv(image, startPoint, mask, visited) {
  // console.time("customFloodFillWithoutCv");

  let rows = image.rows;
  let cols = image.cols;
  var mask = mask || new cv.Mat(rows, cols, cv.CV_8U, new cv.Scalar(0));
  var visited = visited || new Set(); // 방문한 픽셀을 추적
  let stack = [startPoint];
  let originalColor = image.ucharPtr(startPoint.y, startPoint.x)[0];

  while (stack.length > 0) {
    let { x, y } = stack.pop();
    let key = `${x},${y}`;

    // 경계 체크 및 방문 체크를 먼저 수행
    if (x < 0 || y < 0 || x >= cols || y >= rows || visited.has(key)) continue;

    visited.add(key);

    let currentColor = image.ucharPtr(y, x)[0];
    if (currentColor !== originalColor) continue;

    mask.ucharPtr(y, x)[0] = 255;

    // 4방향 이웃 픽셀 추가
    stack.push(
      { x: x + 1, y },
      { x: x - 1, y },
      { x, y: y + 1 },
      { x, y: y - 1 }
    );
  }

  // console.timeEnd("customFloodFillWithoutCv");
  return mask;
}

function opencvMatToBase64(mat) {
  var canvas = document.createElement("canvas");
  canvas.width = mat.cols;
  canvas.height = mat.rows;
  cv.imshow(canvas, mat);
  var base64 = canvas.toDataURL("image/png");
  mat.delete();
  return base64;
}
