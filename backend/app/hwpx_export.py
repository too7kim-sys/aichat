"""Minimal HWPX (한글 Open XML) 생성기.

DOCX 내보내기는 이미 동작하지만, 사내에서 한컴오피스를 표준 도구로
쓰는 경우가 많아 HWPX 도 함께 제공한다. 외부 변환기(libreoffice /
hwp5tools) 의존성 없이 OWPML 스펙에 맞는 ZIP 컨테이너를 직접 작성.

지원 범위:
  · 본문 단락 (plain text). 한글·영문·숫자 OK.
  · 단순 헤더(타이틀)
  · 한 섹션 (section0.xml) 안에 모든 단락
미지원:
  · 글꼴 변경, 굵게/이탤릭, 표, 이미지, 페이지 헤더/푸터

결과 파일은 한컴오피스 2014 SE 이상에서 정상적으로 열린다. 사용자가
스타일을 적용하고 싶으면 한글 안에서 추가 작업.

OWPML 참조: 한컴오피스 공개 표준 HWP 5.0 Open XML
(https://www.hancom.com/etc/hwpDownload.do)
"""
from __future__ import annotations

import html as _html
import io
import uuid
import zipfile


def _esc(s: str) -> str:
    """XML escape — &, <, >, " 만. 한글은 그대로 UTF-8."""
    return _html.escape(s or "", quote=True)


def _container_xml() -> bytes:
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container">\n'
        '  <ocf:rootfiles>\n'
        '    <ocf:rootfile full-path="Contents/content.hpf" '
        'media-type="application/hwpml-package+xml"/>\n'
        '  </ocf:rootfiles>\n'
        '</ocf:container>\n'
    ).encode("utf-8")


def _content_hpf(title: str) -> bytes:
    pkg_id = f"aichat-{uuid.uuid4()}"
    xml = (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<opf:package xmlns:opf="http://www.idpf.org/2007/opf" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'version="1.4" unique-identifier="hwpxid">\n'
        '  <opf:metadata>\n'
        f'    <dc:title>{_esc(title)}</dc:title>\n'
        f'    <dc:identifier id="hwpxid">{_esc(pkg_id)}</dc:identifier>\n'
        '    <dc:language>ko</dc:language>\n'
        '    <opf:meta property="generator">aichat</opf:meta>\n'
        '  </opf:metadata>\n'
        '  <opf:manifest>\n'
        '    <opf:item id="header"   href="header.xml"   '
        'media-type="application/xml"/>\n'
        '    <opf:item id="section0" href="section0.xml" '
        'media-type="application/xml"/>\n'
        '  </opf:manifest>\n'
        '  <opf:spine>\n'
        '    <opf:itemref idref="section0"/>\n'
        '  </opf:spine>\n'
        '</opf:package>\n'
    )
    return xml.encode("utf-8")


_HEADER_XML = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" '
    'version="1.4" secCnt="1">\n'
    '  <hh:beginNum page="1" footnote="1" endnote="1" '
    'pic="1" tbl="1" equation="1"/>\n'
    '  <hh:refList>\n'
    '    <hh:fontfaces itemCnt="1">\n'
    '      <hh:fontface lang="HANGUL" count="1">\n'
    '        <hh:font id="0" face="함초롬바탕" type="TTF"/>\n'
    '      </hh:fontface>\n'
    '    </hh:fontfaces>\n'
    '    <hh:charProperties itemCnt="1">\n'
    '      <hh:charPr id="0" height="1000" textColor="#000000" '
    'shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" '
    'borderFillIDRef="0">\n'
    '        <hh:fontRef hangul="0" latin="0" hanja="0" '
    'japanese="0" other="0" symbol="0" user="0"/>\n'
    '        <hh:ratio hangul="100" latin="100" hanja="100" '
    'japanese="100" other="100" symbol="100" user="100"/>\n'
    '        <hh:spacing hangul="0" latin="0" hanja="0" '
    'japanese="0" other="0" symbol="0" user="0"/>\n'
    '        <hh:relSz hangul="100" latin="100" hanja="100" '
    'japanese="100" other="100" symbol="100" user="100"/>\n'
    '        <hh:offset hangul="0" latin="0" hanja="0" '
    'japanese="0" other="0" symbol="0" user="0"/>\n'
    '      </hh:charPr>\n'
    '    </hh:charProperties>\n'
    '    <hh:paraProperties itemCnt="1">\n'
    '      <hh:paraPr id="0" tabPrIDRef="0" condense="0" '
    'fontLineHeight="0" snapToGrid="0" suppressLineNumbers="0" '
    'checked="0">\n'
    '        <hh:align horizontal="LEFT" vertical="BASELINE"/>\n'
    '        <hh:heading type="NONE" idRef="0" level="0"/>\n'
    '        <hh:breakSetting breakLatinWord="KEEP_WORD" '
    'breakNonLatinWord="KEEP_WORD" widowOrphan="0" '
    'keepWithNext="0" keepLines="0" pageBreakBefore="0" '
    'lineWrap="BREAK"/>\n'
    '        <hh:margin>\n'
    '          <hc:left xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'value="0" unit="HWPUNIT"/>\n'
    '          <hc:right xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'value="0" unit="HWPUNIT"/>\n'
    '          <hc:indent xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'value="0" unit="HWPUNIT"/>\n'
    '          <hc:prev xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'value="0" unit="HWPUNIT"/>\n'
    '          <hc:next xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" '
    'value="0" unit="HWPUNIT"/>\n'
    '        </hh:margin>\n'
    '        <hh:lineSpacing type="PERCENT" value="160" unit="PERCENT"/>\n'
    '        <hh:border borderFillIDRef="0" offsetLeft="0" offsetRight="0" '
    'offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>\n'
    '      </hh:paraPr>\n'
    '    </hh:paraProperties>\n'
    '    <hh:borderFills itemCnt="1">\n'
    '      <hh:borderFill id="0" threeD="0" shadow="0" '
    'centerLine="NONE" breakCellSeparateLine="0">\n'
    '        <hh:slash type="NONE" Crooked="0" isCounter="0"/>\n'
    '        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>\n'
    '        <hh:leftBorder type="NONE" width="0.1mm" color="#000000"/>\n'
    '        <hh:rightBorder type="NONE" width="0.1mm" color="#000000"/>\n'
    '        <hh:topBorder type="NONE" width="0.1mm" color="#000000"/>\n'
    '        <hh:bottomBorder type="NONE" width="0.1mm" color="#000000"/>\n'
    '        <hh:diagonal type="NONE" width="0.1mm" color="#000000"/>\n'
    '      </hh:borderFill>\n'
    '    </hh:borderFills>\n'
    '    <hh:styles itemCnt="1">\n'
    '      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" '
    'paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" '
    'lockForm="0"/>\n'
    '    </hh:styles>\n'
    '  </hh:refList>\n'
    '</hh:head>\n'
).encode("utf-8")


def _section_xml(paragraphs: list[str]) -> bytes:
    parts: list[str] = [
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
        'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">\n'
    ]
    for raw in paragraphs:
        text = (raw or "").replace("\r", "")
        # 빈 단락도 표시(줄바꿈 보존). 본문 줄바꿈 → 단락 단위 분리.
        for line in text.split("\n"):
            parts.append(
                '  <hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0" '
                'columnBreak="0" merged="0">\n'
                '    <hp:run charPrIDRef="0">\n'
                f'      <hp:t>{_esc(line)}</hp:t>\n'
                '    </hp:run>\n'
                '    <hp:linesegarray>\n'
                '      <hp:lineseg textpos="0" vertpos="0" vertsize="1000" '
                'textheight="1000" baseline="850" spacing="600" '
                'horzpos="0" horzsize="42520" flags="393216"/>\n'
                '    </hp:linesegarray>\n'
                '  </hp:p>\n'
            )
    parts.append('</hs:sec>\n')
    return "".join(parts).encode("utf-8")


def build_hwpx(title: str, paragraphs: list[str]) -> bytes:
    """타이틀 + 단락 리스트를 받아 HWPX 바이너리(zip) 반환.

    단락 안의 \\n 은 줄바꿈으로 보존. 글꼴은 함초롬바탕 10pt 고정.
    사용자는 한글에서 열어 추가 편집 가능.
    """
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        # mimetype 만 STORED + 첫 번째 — OWPML/EPUB 공통 규약.
        info = zipfile.ZipInfo("mimetype")
        info.compress_type = zipfile.ZIP_STORED
        zf.writestr(info, "application/hwp+zip")
        zf.writestr("META-INF/container.xml", _container_xml())
        zf.writestr("Contents/content.hpf", _content_hpf(title))
        zf.writestr("Contents/header.xml", _HEADER_XML)
        zf.writestr("Contents/section0.xml", _section_xml(paragraphs))
    return buf.getvalue()
